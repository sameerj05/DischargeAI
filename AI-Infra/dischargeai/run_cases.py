"""Run a JSON file of test cases through the graph and save inputs + outputs side by side.

    python -m dischargeai.run_cases                                   # samples/test_cases.json
    python -m dischargeai.run_cases --cases my_cases.json --out output/my_results.json
    python -m dischargeai.run_cases --only natural_language_gi_bleed

Cases file shape:
    {"cases": [{"id": "...", "input_type": "structured" | "natural_language",
                "description": "...", "sources": [{"name": "note.txt", "text": "..."}]}]}
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from .__main__ import format_sources
from .bedrock import ModelOutputError, make_client
from .comprehend import ComprehendUnavailable
from .config import Settings
from .graph import build_graph, recursion_limit
from .render import render_markdown, render_review


def load_cases(path: Path, only: list[str] | None) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    cases = data.get("cases") if isinstance(data, dict) else None
    if not isinstance(cases, list) or not cases:
        raise ValueError(f"{path} has no 'cases' list")
    for c in cases:
        if not c.get("id") or not isinstance(c.get("sources"), list) or not c["sources"]:
            raise ValueError(f"Every case needs an 'id' and a non-empty 'sources' list: {c.get('id')!r}")
        for s in c["sources"]:
            if not s.get("name") or not str(s.get("text", "")).strip():
                raise ValueError(f"Case {c['id']}: every source needs a 'name' and non-empty 'text'")
    if only:
        missing = set(only) - {c["id"] for c in cases}
        if missing:
            raise ValueError(f"Unknown case id(s): {', '.join(sorted(missing))}")
        cases = [c for c in cases if c["id"] in only]
    return cases


def _fact_counts(review: dict[str, Any]) -> dict[str, int]:
    facts = review.get("facts", [])
    return {s: sum(1 for f in facts if f["status"] == s) for s in ("included", "missing", "incorrect")}


def run_case(case: dict[str, Any], settings: Settings, app) -> dict[str, Any]:
    notes = format_sources([(s["name"], s["text"]) for s in case["sources"]])
    started = time.monotonic()
    state: dict[str, Any] = {"notes": notes, "rounds": []}

    def log(msg: str) -> None:
        print(f"[{case['id']}] {msg}", flush=True)

    log("started")
    for event in app.stream(state, config={"recursion_limit": recursion_limit(settings)}, stream_mode="updates"):
        for node, update in event.items():
            for key, value in update.items():
                state[key] = state.get(key, []) + value if key == "rounds" else value
            if node == "review":
                r = update["rounds"][-1]
                log(f"round {r['number']} [{r['mode']}]: {'PASS' if r['passed'] else 'FAIL'} "
                    f"(grade {r['grade_level']:.1f}, {len(r['problems'])} problem(s), {r['lines']} lines)")
            elif node == "choose_fix":
                log(f"choose_fix -> {update['fix_mode']} from round {update['fix_base']}: {update['fix_reason']}")
            elif node == "patch_summary":
                e = update.get("last_edits") or {}
                log(f"patch_summary: {len(e.get('applied', []))} edit(s) applied, "
                    f"{len(e.get('rejected', []))} rejected")
            elif node == "comprehend_medical":
                log(f"comprehend_medical: {update['medical_entities']['status']}")
            else:
                log(f"{node} done")

    final_round = state["rounds"][-1] if state["rounds"] else {}
    best_text = state.get("summary", "")
    return {
        "id": case["id"],
        "input_type": case.get("input_type", ""),
        "description": case.get("description", ""),
        "input": {
            "sources": case["sources"],
            "compiled_notes": notes,
        },
        "output": {
            "status": state.get("status"),
            "flags": state.get("flags", []),
            "rounds_used": len(state["rounds"]),
            "final_grade_level": round(final_round.get("grade_level", 0.0), 2),
            "going_home_plan_lines": best_text.splitlines(),
            "going_home_plan_text": best_text,
            # Each patient line followed by the exact note quotes that prove it.
            "plan_with_proof_lines": render_review(state["plan"]).splitlines() if state.get("plan") else [],
            "plan": state.get("plan"),
        },
        "pipeline": {
            "patient_context": state.get("patient_context"),
            "comprehend_medical": state.get("medical_entities"),
            "rounds": [
                {
                    "number": r["number"],
                    "mode": r["mode"],
                    "fixed_from_round": r["base_round"],
                    "why_this_mode": r["fix_reason"],
                    "edits": r["edits"],
                    "lines": r["lines"],
                    "passed": r["passed"],
                    "grade_level": round(r["grade_level"], 2),
                    "facts": _fact_counts(r["review"]),
                    "problems": r["problems"],
                    "ignored_reviewer_comments": r["review"].get("dropped_claims", []),
                    "draft_with_proof_lines": r["review_view"].splitlines(),
                }
                for r in state["rounds"]
            ],
        },
        "seconds": round(time.monotonic() - started, 1),
    }


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Run DischargeAI test cases and save inputs and outputs.")
    parser.add_argument("--cases", type=Path, default=Path("samples/test_cases.json"))
    parser.add_argument("--out", type=Path, default=Path("output/test_results.json"))
    parser.add_argument("--only", nargs="+", help="Run only these case ids")
    parser.add_argument("--io-out", type=Path,
                        help="Also write a JSON with only each case's input and Markdown output, for reviewers")
    parser.add_argument("--md-dir", type=Path, help="Also write each case's Markdown output to <dir>/<id>.md")
    args = parser.parse_args()

    settings = Settings.from_env()
    try:
        cases = load_cases(args.cases, args.only)
    except (OSError, ValueError) as e:
        print(f"Error: {e}")
        return 1

    # One compiled graph and one Bedrock client shared by all cases (both are thread-safe).
    app = build_graph(settings, client=make_client(settings.aws_profile, settings.aws_region))
    results: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=len(cases)) as pool:
        futures = {pool.submit(run_case, c, settings, app): c["id"] for c in cases}
        for future, case_id in futures.items():
            try:
                results.append(future.result())
            except (ModelOutputError, ComprehendUnavailable, ClientError, BotoCoreError, ValueError) as e:
                print(f"[{case_id}] FAILED: {e}")
                errors.append({"id": case_id, "error": str(e)})

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "settings": {
            "region": settings.aws_region,
            "context_model": settings.context_model,
            "writer_model": settings.writer_model,
            "reviewer_model": settings.reviewer_model,
            "max_rounds": settings.max_rounds,
            "max_grade_level": settings.max_grade_level,
            "comprehend_mode": settings.comprehend_mode,
        },
        "summary": [
            {"id": r["id"], "input_type": r["input_type"], "status": r["output"]["status"],
             "rounds_used": r["output"]["rounds_used"], "final_grade_level": r["output"]["final_grade_level"],
             "flags": r["output"]["flags"], "seconds": r["seconds"]}
            for r in results
        ],
        "errors": errors,
        "results": results,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    # Reviewer-facing export: just what went in and what the patient would get.
    order = {c["id"]: i for i, c in enumerate(cases)}
    ordered = sorted((r for r in results if r["output"]["plan"]), key=lambda r: order[r["id"]])
    if args.io_out:
        io_cases = [
            {
                "id": r["id"],
                "title": r["description"],
                "input": {s["name"].rsplit(".", 1)[0]: s["text"] for s in r["input"]["sources"]},
                "output": render_markdown(r["output"]["plan"]),
            }
            for r in ordered
        ]
        args.io_out.parent.mkdir(parents=True, exist_ok=True)
        args.io_out.write_text(json.dumps({"cases": io_cases}, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Saved input/output pairs to {args.io_out}")
    if args.md_dir:
        args.md_dir.mkdir(parents=True, exist_ok=True)
        for r in ordered:
            (args.md_dir / f"{r['id']}.md").write_text(render_markdown(r["output"]["plan"]), encoding="utf-8")
        print(f"Saved Markdown plans to {args.md_dir}")

    print(f"\nSaved {len(results)} result(s) to {args.out}")
    for s in report["summary"]:
        print(f"  {s['id']:<28} {s['status']:<22} rounds={s['rounds_used']} grade={s['final_grade_level']}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
