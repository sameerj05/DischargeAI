"""Terminal output for each step of the graph."""

from __future__ import annotations

from typing import Any

WIDTH = 78


def banner(title: str) -> None:
    print()
    print("=" * WIDTH)
    print(f" {title}")
    print("=" * WIDTH)


def _join(*parts: str) -> str:
    return " | ".join(p for p in parts if p)


def show_input(notes: str, sources: list[str]) -> None:
    banner(f"INPUT: clinician notes ({len(sources)} file(s))")
    print(notes.strip())


def show_context(ctx: dict[str, Any]) -> None:
    banner("STEP 1: patient context (context agent)")
    p = ctx["patient"]
    print("Patient:   " + (_join(p["name"], p["age"], p["sex"]) or "(not given)"))
    if p["admit_date"] or p["discharge_date"]:
        print(f"Stay:      {p['admit_date'] or '?'} to {p['discharge_date'] or '?'}")

    def section(title: str, lines: list[str]) -> None:
        print(f"\n{title} ({len(lines)}):")
        for line in lines or ["(none)"]:
            print(f"  - {line}")

    section("Diagnoses", [_join(d["name"], d["details"]) for d in ctx["diagnoses"]])
    section("Hospital course", ctx["hospital_course"])
    section("Medications", [
        _join(m["label_in_notes"].upper() or "(no label)",
              m["name"] + ("" if m["name_confidence"] == "exact" else f" [{m['name_confidence']}: heard '{m['name_as_heard']}']"), m["dose"], m["route"], m["frequency"],
              m["timing"], m["duration"], m["reason"], m["notes"])
        for m in ctx["medications"]
    ])
    section("Follow-ups", [_join(f["with_whom"], f["date"], f["time"], f["location"], f["purpose"])
                           for f in ctx["follow_ups"]])
    section("Tests", [_join(t["name"], t["when"], t["purpose"]) for t in ctx["tests"]])
    section("Home care", ctx["home_care"])
    section("Activity / diet", ctx["activity_diet"])
    section("Call the doctor if", ctx["call_doctor_signs"])
    section("Emergency signs", ctx["emergency_signs"])
    if ctx["other"]:
        section("Other", ctx["other"])
    if ctx["unclear_items"]:
        section("UNCLEAR OR CONFLICTING (will become questions for the care team)", ctx["unclear_items"])


def show_comprehend(cm: dict[str, Any]) -> None:
    banner("STEP 1b: Amazon Comprehend Medical entities (runs in parallel with step 1)")
    if cm["status"] != "ok":
        print(f"Not used: {cm['reason']}")
        print("Continuing with the raw notes and the patient record only.")
        return
    print(f"Model {cm['model_version']} | {cm['characters']} characters in {cm['chunks']} request chunk(s)")

    def line(e: dict[str, Any]) -> str:
        parts = [f"{e['text']} ({e['type'].lower()}, {e['score']:.2f})"]
        if e.get("attributes"):
            parts.append(", ".join(f"{k.lower()}={v}" for k, v in e["attributes"].items()))
        if e.get("rxnorm"):
            rx = e["rxnorm"]
            parts.append(f"RxNorm {rx['code']}: {rx['description']} ({rx['score']:.2f})")
        if e.get("traits"):
            parts.append("traits=" + ",".join(e["traits"]))
        return " | ".join(parts)

    for key, title in (("medications", "Medications"), ("conditions", "Conditions"),
                       ("tests_treatments", "Tests / treatments / procedures"), ("social", "Social / behavioral")):
        items = cm.get(key, [])
        print(f"\n{title} ({len(items)}):")
        for e in items or [{"text": "(none)", "type": "", "score": 0}]:
            print(f"  - {line(e)}" if e["type"] else "  - (none)")
    times = cm.get("time_expressions", [])
    if times:
        print(f"\nTime expressions ({len(times)}): " + "; ".join(t["text"] for t in times))


def show_draft(round_no: int, draft: str) -> None:
    banner(f"STEP 2: round {round_no} Going-Home Plan draft with line ids and proof quotes (writer agent)")
    print(draft)


def show_review(record: dict[str, Any], max_grade: float) -> None:
    banner(f"STEP 3: round {record['number']} review (reviewer agent + code checks)")
    facts = record["review"]["facts"]
    counts = {s: sum(1 for f in facts if f["status"] == s) for s in ("included", "missing", "incorrect")}
    print(f"Facts checked:  {len(facts)}  "
          f"(included {counts['included']}, missing {counts['missing']}, incorrect {counts['incorrect']})")
    print(f"Grade level:    {record['grade_level']:.1f}  (limit {max_grade:.1f})")
    print(f"Result:         {'PASS' if record['passed'] else 'FAIL, sending feedback to writer'}")
    for p in record["problems"]:
        print(f"  - {p}")
    dropped = record["review"].get("dropped_claims", [])
    if dropped:
        print(f"  (ignored {len(dropped)} reviewer comment(s) that did not quote the plan)")


def show_fix(update: dict[str, Any]) -> None:
    mode = update["fix_mode"]
    banner(f"STEP 4: choose fix -> {mode.upper()} (fixing round {update['fix_base']})")
    print(f"Why: {update['fix_reason']}")
    if mode == "patch":
        print(f"Lines the writer may edit: {', '.join(update['fix_allowed']) or '(none, adds only)'}")
    elif mode == "section":
        print(f"Sections to rewrite: {', '.join(update['fix_sections'])}")


def show_edits(edits: dict[str, Any]) -> None:
    for e in edits.get("applied", []):
        print(f"  applied:  {e.get('action')} {e.get('line_id') or e.get('section')} -- {e.get('fixes', '')}")
    for e in edits.get("rejected", []):
        print(f"  REJECTED: {e.get('action')} {e.get('line_id') or e.get('section')} -- {e['rejected_because']}")


def show_final(state: dict[str, Any]) -> None:
    rounds = len(state.get("rounds", []))
    if state["status"] == "approved":
        banner(f"FINAL: APPROVED after {rounds} round(s)")
    elif state["status"] == "needs_clinician_check":
        banner(f"FINAL: PASSED REVIEW after {rounds} round(s), BUT A CLINICIAN MUST CHECK IT FIRST")
        for f in state.get("flags", []):
            print(f"  ! {f}")
        print()
    else:
        banner(f"FINAL: NEEDS HUMAN REVIEW (no draft passed in {rounds} rounds; showing the best one)")
    print(state["summary"])
    print()
