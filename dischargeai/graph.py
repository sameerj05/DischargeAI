"""LangGraph topology for DischargeAI.

    START -+-> build_context ------+
           |                       +--> write_summary --> review --pass--> finalize -> END
           +-> comprehend_medical -+         ^              |
                                             |              +--out of rounds--> human_review -> END
                                             |              |
                                             |          choose_fix  (code decides how much to redo)
                                             |        /     |      \\
                                   (full) ---+  patch_summary  rewrite_sections
                                                      \\         /
                                                       -> review

build_context (Claude) and comprehend_medical (Amazon Comprehend Medical) run in parallel on
the raw notes. write_summary waits for both and writes the first full plan.

After every failed review, choose_fix (plain code, no model) looks at how much of the plan
was flagged and picks the smallest fix that can work:
  patch     - only the flagged lines (and lines for the same medicine) are edited
  section   - only the section group(s) holding most problems are rewritten
  full      - the whole plan is rewritten
It escalates (patch -> section -> full) when a fix does not reduce the problems, and rolls
back to the best draft so far when a round makes things worse.

Every node reads the shared DischargeState and returns only the keys it changes.
"""

from __future__ import annotations

import operator
import re
import time
from dataclasses import asdict
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph

from . import comprehend
from .agents import Review, run_context_agent, run_patch_writer, run_reviewer, run_section_writer, run_writer
from .bedrock import make_client
from .config import Settings
from .plan_ops import (CATEGORY_GROUP, GROUPS, apply_edits, group_of, item_med_key, iter_items, linked_ids, med_key,
                       merge_sections)
from .glossary import hard_word_problems, jargon_problems
from .proof import lines_matching, proof_problems, urgency_problems
from .readability import grade_level, missing_terms
from .render import FREQUENCY_SLOTS, SLOTS, TIME_SLOTS, proof_entries, render_plan, render_review
from .sensitive import redact_plan, sensitive_problems

# Routing thresholds for choose_fix.
FULL_SHARE = 0.25        # more than this share of lines flagged -> full rewrite
FULL_MISSING = 5         # more than this many missing facts -> full rewrite
SECTION_MIN_LINES = 4    # a section rewrite needs at least this many flagged lines ...
SECTION_SHARE = 0.6      # ... with at least this share of them in one section group
MODE_ORDER = {"patch": 0, "section": 1, "full": 2}
SMALL_PLAN_PROBLEMS = 3  # a plan with this many problems or fewer is never fully rewritten
MAX_HARD_LINES = 3       # reading level: flag at most this many lines per round ...
HARD_LINE_MARGIN = 2.0   # ... and only lines this far above the grade limit


class DischargeState(TypedDict, total=False):
    notes: str                                       # compiled clinician input
    patient_context: dict[str, Any]                  # context agent output
    medical_entities: dict[str, Any]                 # Amazon Comprehend Medical output (or why it is missing)
    plan: dict[str, Any]                             # latest plan (structured, every item has an id)
    draft: str                                       # latest plan rendered as the patient checklist
    review_view: str                                 # same plan with [id] and proof quotes under each line
    round: int
    last_passed: bool
    rounds: Annotated[list[dict[str, Any]], operator.add]  # history, appended each round
    # Set by choose_fix for the next writer node:
    fix_mode: str                                    # "full" | "section" | "patch"
    fix_base: int                                    # round number whose plan is being fixed
    fix_issues: list[dict[str, Any]]                 # problems to fix
    fix_sections: list[str]                          # section mode: sections to rewrite
    fix_allowed: list[str]                           # patch mode: line ids that may be edited
    fix_reason: str                                  # why this mode was chosen
    last_edits: dict[str, Any]                       # patch mode: applied and rejected edits
    status: str                                      # "approved" | "needs_clinician_check" | "needs_human_review"
    flags: list[str]                                 # reasons a plan still needs a clinician
    summary: str                                     # final output
    started_at: float                                # time.time() when the run started (time budget)


# ---------------------------------------------------------------------------
# Code-level checks
# ---------------------------------------------------------------------------

NOT_DAILY = re.compile(
    r"every other day|every \d+ days|every (two|three|four|five|six|seven) days|weekly|once a week|"
    r"times a week|\bon (mon|tue|wed|thu|fri|sat|sun)[a-z]*", re.IGNORECASE)


def _issue(text: str, lines: list[str] | None = None, kind: str = "line", group: str = "") -> dict[str, Any]:
    return {"text": text, "lines": lines or [], "kind": kind, "group": group}


def schedule_problems(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """Checklist rules that could cause a wrong or double dose."""
    issues: list[dict[str, Any]] = []
    sched = plan["schedule"]
    titles = {key: title for key, title, _ in SLOTS}

    # Same medicine twice in one slot.
    for key, _, _ in SLOTS:
        by_med: dict[str, list[str]] = {}
        for d in sched[key]:
            by_med.setdefault(med_key(d["medicine"]), []).append(d["id"])
        for med, ids in sorted(by_med.items()):
            if len(ids) > 1:
                issues.append(_issue(f"DOUBLE DOSE RISK: '{med}' is listed more than once under {titles[key]}. "
                                     "List it once.", ids))

    # Same medicine in two kinds of slot (clock times / a frequency group / other schedules).
    kinds: dict[str, dict[str, list[str]]] = {}
    for key, _, _ in SLOTS:
        if key == "as_needed":
            continue  # a later as-needed phase is allowed next to a scheduled phase
        kind = "clock times" if key in TIME_SLOTS else titles[key]
        for d in sched[key]:
            kinds.setdefault(med_key(d["medicine"]), {}).setdefault(kind, []).append(d["id"])
    for med, found in sorted(kinds.items()):
        if len(found) > 1:
            ids = [i for group in found.values() for i in group]
            issues.append(_issue(f"DOUBLE DOSE RISK: '{med}' is under {' and '.join(sorted(found))}. "
                                 "Put each medicine in one kind of slot only.", ids))

    # Not-every-day medicines in an every-day slot.
    for key in TIME_SLOTS + FREQUENCY_SLOTS:
        for d in sched[key]:
            if NOT_DAILY.search(f"{d['medicine']} {d['note']}"):
                issues.append(_issue(f"WRONG SLOT: '{d['medicine']}' is not taken every day but is under "
                                     f"{titles[key]}. Move it to schedule.other_schedule.", [d["id"]]))
    return issues


def reviewer_issues(review: Review, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Turn the reviewer's findings into issues tied to plan lines where possible."""
    issues: list[dict[str, Any]] = []
    for f in review.missing:
        issues.append(_issue(f"MISSING ({f['category']}): {f['fact']}" + (f" -- {f['problem']}" if f["problem"] else ""),
                             kind="missing", group=CATEGORY_GROUP.get(f["category"], "care")))
    for f in review.incorrect:
        lines = lines_matching(f["plan_quote"], entries) if f.get("plan_quote") else []
        text = f"INCORRECT ({f['category']}): {f['fact']}" + (f" -- {f['problem']}" if f["problem"] else "")
        issues.append(_issue(text, lines) if lines else
                      _issue(text, kind="group", group=CATEGORY_GROUP.get(f["category"], "care")))
    for c in review.unsupported_claims:
        lines = lines_matching(c["quote"], entries)
        text = f"NOT IN THE NOTES, remove or fix it: \"{c['quote']}\" -- {c['why']}"
        issues.append(_issue(text, lines) if lines else _issue(text, kind="global"))
    for name in review.missing_med_names:
        issues.append(_issue(f"MEDICINE NAME NOT FOUND, write it exactly as '{name}'", kind="missing",
                             group="medicines"))
    return issues


def readability_issues(review: Review, entries: list[dict[str, Any]], protected: list[str],
                       max_grade: float) -> list[dict[str, Any]]:
    """Reading level is pass/fail.

    1. Every line the reviewer says a 5th grader could not read blocks approval, whatever the
       overall score is. These are tied to lines, so the fix is a patch of just those lines.
    2. If the overall Flesch-Kincaid grade of the plain words is over the limit, the few
       hardest long lines are flagged too (one-line scores are noisy, so only a handful).
    """
    hard: dict[str, str] = {}
    for r in review.readability_issues:
        for line_id in lines_matching(r["quote"], entries):
            hard.setdefault(line_id, f"TOO HARD FOR A 5TH GRADER: \"{r['quote']}\" -- {r['problem']}")
    if review.grade_level > max_grade:
        scored = sorted(((grade_level(e["text"], protected), e) for e in entries if len(e["text"].split()) >= 8),
                        key=lambda ge: ge[0], reverse=True)
        picked = [ge for ge in scored if ge[0] > max_grade + HARD_LINE_MARGIN][:MAX_HARD_LINES] or scored[:1]
        for g, e in picked:
            hard.setdefault(e["id"], f"HARD TO READ (grade {g:.1f}): \"{e['text']}\" -- use shorter sentences "
                                     "and simpler words.")
    issues = [_issue(text, [line_id]) for line_id, text in hard.items()]
    if review.grade_level > max_grade:
        summary = f"TOO HARD TO READ overall: grade {review.grade_level:.1f}, the limit is {max_grade:.1f}."
        issues.append(_issue(summary, kind="global") if not issues else _issue(summary, kind="note"))
    return issues


# ---------------------------------------------------------------------------
# Fix routing (plain code)
# ---------------------------------------------------------------------------

def _flagged(issues: list[dict[str, Any]]) -> set[str]:
    return {line for i in issues if i["kind"] == "line" for line in i["lines"]}


def mode_for(issues: list[dict[str, Any]], total_lines: int) -> tuple[str, list[str], str]:
    """Pick the smallest fix for these issues: (mode, section groups, reason)."""
    flagged = _flagged(issues)
    missing = [i for i in issues if i["kind"] == "missing"]
    group_issues = [i for i in issues if i["kind"] == "group"]
    global_issues = [i for i in issues if i["kind"] == "global"]
    share = len(flagged) / max(1, total_lines)

    if share > FULL_SHARE:
        return "full", [], f"{len(flagged)} of {total_lines} lines flagged ({share:.0%} > {FULL_SHARE:.0%})"
    if len(missing) > FULL_MISSING:
        return "full", [], f"{len(missing)} missing facts (> {FULL_MISSING})"
    if global_issues and not flagged and not missing and not group_issues:
        if len(global_issues) > SMALL_PLAN_PROBLEMS:
            return "full", [], "only plan-wide problems that are not tied to any line"
        return "section", ["care", "warnings"], "a few plan-wide problems that are not tied to any line"

    counts: dict[str, int] = {}
    for line_id in flagged:
        g = group_of(line_id.rsplit(".", 1)[0])
        counts[g] = counts.get(g, 0) + 1
    if flagged and len(flagged) >= SECTION_MIN_LINES:
        top, n = max(counts.items(), key=lambda kv: kv[1])
        if n / len(flagged) >= SECTION_SHARE:
            groups = sorted({top} | {i["group"] for i in missing + group_issues})
            return "section", groups, (f"{n} of {len(flagged)} flagged lines are in '{top}'")
    if group_issues:
        groups = sorted({i["group"] for i in group_issues + missing})
        return "section", groups, "a wrong fact could not be tied to a specific line"
    return "patch", [], f"{len(flagged)} of {total_lines} lines flagged ({share:.0%}), {len(missing)} missing"


def lines_named_by_missing(issues: list[dict[str, Any]], plan: dict[str, Any]) -> set[str]:
    """Lines for a medicine that a missing fact is about. 'Furosemide will make you urinate more'
    is often best fixed by editing the furosemide line, so that line may be edited too."""
    texts = " ".join(i["text"].lower() for i in issues if i["kind"] in ("missing", "group"))
    if not texts:
        return set()
    return {item["id"] for section, item in iter_items(plan)
            if (k := item_med_key(section, item)) and len(k) > 3 and re.search(rf"\b{re.escape(k)}\b", texts)}


def _escalate(mode: str) -> str:
    return {"patch": "section", "section": "full", "full": "full"}[mode]


def choose_fix_plan(rounds: list[dict[str, Any]]) -> dict[str, Any]:
    """Decide what the next writer node fixes, from the round history."""
    current = rounds[-1]
    best = min(rounds, key=lambda r: (len(r["problems"]), -r["number"]))
    rolled_back = len(current["problems"]) > len(best["problems"])
    base = best if rolled_back else current
    prev = rounds[-2] if len(rounds) >= 2 else None
    stalled = not rolled_back and prev is not None and len(current["problems"]) >= len(prev["problems"])

    mode, groups, reason = mode_for(base["issues"], len(proof_entries(base["plan"])))
    last_mode = current["mode"]
    # Escalate only when a fix did not help at all (stalled). A fix that made things worse is
    # undone by rolling back, and the next try is the normal small fix from the best draft:
    # bigger rewrites of a nearly finished plan were what made things worse in testing.
    # A plan with only a few problems is never fully rewritten.
    if stalled:
        escalated = _escalate(last_mode)
        if escalated == "full" and len(base["problems"]) <= SMALL_PLAN_PROBLEMS:
            escalated = "section"
        if MODE_ORDER[escalated] > MODE_ORDER[mode]:
            mode, reason = escalated, f"last {last_mode} did not reduce the problems, escalating"
            if mode == "section" and not groups:
                counts: dict[str, int] = {}
                for line_id in _flagged(base["issues"]):
                    g = group_of(line_id.rsplit(".", 1)[0])
                    counts[g] = counts.get(g, 0) + 1
                missing_groups = {i["group"] for i in base["issues"] if i["kind"] in ("missing", "group")}
                groups = sorted(({max(counts, key=counts.get)} if counts else set()) | missing_groups) or ["medicines"]
    if rolled_back:
        reason = f"rolled back to round {base['number']} (round {current['number']} had more problems); " + reason

    sections = [s for g in groups for s in GROUPS[g]]
    flagged = _flagged(base["issues"]) | lines_named_by_missing(base["issues"], base["plan"])
    allowed = sorted(flagged | linked_ids(base["plan"], flagged))
    return {"fix_mode": mode, "fix_base": base["number"], "fix_issues": base["issues"],
            "fix_sections": sections, "fix_allowed": allowed, "fix_reason": reason,
            "plan": base["plan"], "review_view": base["review_view"], "draft": base["draft"]}


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------

def build_graph(settings: Settings, client=None, cm_client=None):
    """Compile the graph. Pass clients to reuse them; tests can pass stubs."""
    client = client or make_client(settings.aws_profile, settings.aws_region)

    def build_context(state: DischargeState) -> dict[str, Any]:
        started = state.get("started_at") or time.time()
        return {"patient_context": run_context_agent(client, settings.context_model, state["notes"]), "round": 0,
                "started_at": started}

    def comprehend_medical(state: DischargeState) -> dict[str, Any]:
        if settings.comprehend_mode == "off":
            return {"medical_entities": comprehend.disabled()}
        try:
            cm = cm_client or comprehend.make_client(settings.aws_profile, settings.comprehend_region)
            return {"medical_entities": comprehend.analyze(cm, state["notes"])}
        except comprehend.ComprehendUnavailable as e:
            if settings.comprehend_mode == "on":
                raise
            # "auto": keep going on the raw notes alone and record why.
            return {"medical_entities": comprehend.unavailable(str(e))}

    def _new_draft(state: DischargeState, plan: dict[str, Any], mode: str, edits: dict | None = None):
        return {"plan": plan, "draft": render_plan(plan), "review_view": render_review(plan),
                "round": state.get("round", 0) + 1, "fix_mode": mode, "last_edits": edits or {}}

    def write_summary(state: DischargeState) -> dict[str, Any]:
        rewriting = state.get("round", 0) > 0
        plan = run_writer(
            client, settings.writer_model, state["notes"], state["patient_context"],
            medical_entities=state.get("medical_entities"),
            previous_draft=state.get("review_view") if rewriting else None,
            issues=state.get("fix_issues") if rewriting else None,
        )
        return _new_draft(state, plan, "full")

    def rewrite_sections(state: DischargeState) -> dict[str, Any]:
        sections = tuple(state["fix_sections"])
        new_sections = run_section_writer(
            client, settings.writer_model, state["notes"], state["patient_context"],
            state.get("medical_entities"), state["review_view"], sections, state["fix_issues"],
        )
        return _new_draft(state, merge_sections(state["plan"], new_sections), "section")

    def patch_summary(state: DischargeState) -> dict[str, Any]:
        allowed = set(state["fix_allowed"])
        edits = run_patch_writer(
            client, settings.writer_model, state["notes"], state["patient_context"],
            state.get("medical_entities"), state["review_view"], state["fix_issues"], allowed,
        )
        plan, applied, rejected = apply_edits(state["plan"], edits, allowed)
        return _new_draft(state, plan, "patch", {"applied": applied, "rejected": rejected})

    def review(state: DischargeState) -> dict[str, Any]:
        plan, draft, context, notes = state["plan"], state["draft"], state["patient_context"], state["notes"]
        result = run_reviewer(client, settings.reviewer_model, notes, draft, state["review_view"])
        entries = proof_entries(plan)

        # Deterministic checks on top of the LLM review. Medicine names come from the
        # context agent, so this check does not depend on the reviewer remembering them.
        # Only names written verbatim in the notes are enforced: a garbled transcript word
        # must never be forced into the plan.
        # Only real drug names are enforced. Descriptions like "Previous lower-dose furosemide
        # regimen" or "Ibuprofen/other NSAIDs" must be allowed to be reworded in plain words.
        med_names = [m["name"] for m in context["medications"]
                     if m["name_confidence"] == "exact" and m["name"].lower() in notes.lower()
                     and len(m["name"].split()) <= 2 and not re.search(r"[/,]|regimen|previous|other|dose",
                                                                       m["name"], re.I)]
        result.missing_med_names = missing_terms(draft, med_names)
        protected = med_names + [d["name"] for d in context["diagnoses"]] + result.medical_terms
        result.grade_level = grade_level(draft, protected)

        issues = (proof_problems(entries, notes)
                  + urgency_problems(entries, notes)
                  + schedule_problems(plan)
                  + sensitive_problems(entries)
                  + jargon_problems(entries)
                  + hard_word_problems(entries)
                  + reviewer_issues(result, entries)
                  + readability_issues(result, entries, protected, settings.max_grade_level))
        # The plan passes when there are no problems. The reviewer's own approved flag is recorded
        # but does not decide: it sometimes says "not approved" while listing nothing wrong.
        problems = [i["text"] for i in issues if i["kind"] != "note"]
        record = {
            "number": state["round"],
            "mode": state.get("fix_mode", "full"),
            "base_round": state.get("fix_base") if state["round"] > 1 else None,
            "fix_reason": state.get("fix_reason", "first draft") if state["round"] > 1 else "first draft",
            "edits": state.get("last_edits", {}),
            "draft": draft,
            "review_view": state["review_view"],
            "plan": plan,
            "passed": not problems,
            "problems": problems,
            "issues": issues,
            "lines": len(entries),
            "grade_level": result.grade_level,
            "review": asdict(result),
        }
        return {"rounds": [record], "last_passed": not problems}

    def choose_fix(state: DischargeState) -> dict[str, Any]:
        return choose_fix_plan(state["rounds"])

    def _final(plan: dict[str, Any], status: str, flags: list[str]) -> dict[str, Any]:
        # Last line of defense: no drug-use or sexual-history line ever leaves the system.
        clean, removed = redact_plan(plan)
        if removed:
            flags = flags + [f"Removed {len(removed)} line(s) that mentioned drug use or sexual history."]
        return {"status": status, "flags": flags, "plan": clean, "summary": render_plan(clean)}

    def finalize(state: DischargeState) -> dict[str, Any]:
        # A plan can pass review and still need a clinician: an unclear medicine name must
        # be confirmed by a person before the patient gets it.
        flags = list(dict.fromkeys(
            f"Medicine name is unclear in the notes ('{m['name_as_heard'] or m['name']}'). Confirm it."
            for m in state["patient_context"]["medications"] if m["name_confidence"] == "uncertain"
        ))
        return _final(state["plan"], "needs_clinician_check" if flags else "approved", flags)

    def human_review(state: DischargeState) -> dict[str, Any]:
        # Never hand an unapproved summary to a patient as if it were final.
        best = min(state["rounds"], key=lambda r: (len(r["problems"]), -r["number"]))
        flags = ["Stopped at the time limit before the plan passed review."] if _out_of_time(state) else []
        return _final(best["plan"], "needs_human_review", flags)

    def _out_of_time(state: DischargeState) -> bool:
        """True if another round is not expected to finish within the time budget."""
        budget = settings.time_budget_seconds
        if budget <= 0 or not state.get("started_at"):
            return False
        elapsed = time.time() - state["started_at"]
        per_round = elapsed / max(1, state.get("round", 1))  # includes the setup steps, so it errs long
        return elapsed + per_round > budget

    def route_after_review(state: DischargeState) -> str:
        if state["last_passed"]:
            return "finalize"
        if state["round"] >= settings.max_rounds or _out_of_time(state):
            return "human_review"
        return "choose_fix"

    def route_fix(state: DischargeState) -> str:
        return {"patch": "patch_summary", "section": "rewrite_sections", "full": "write_summary"}[state["fix_mode"]]

    graph = StateGraph(DischargeState)
    graph.add_node("build_context", build_context)
    graph.add_node("comprehend_medical", comprehend_medical)
    graph.add_node("write_summary", write_summary)
    graph.add_node("review", review)
    graph.add_node("choose_fix", choose_fix)
    graph.add_node("patch_summary", patch_summary)
    graph.add_node("rewrite_sections", rewrite_sections)
    graph.add_node("finalize", finalize)
    graph.add_node("human_review", human_review)

    # Fan out from START, then join: write_summary waits for BOTH nodes the first time.
    graph.add_edge(START, "build_context")
    graph.add_edge(START, "comprehend_medical")
    graph.add_edge(["build_context", "comprehend_medical"], "write_summary")
    for writer in ("write_summary", "patch_summary", "rewrite_sections"):
        graph.add_edge(writer, "review")
    graph.add_conditional_edges(
        "review", route_after_review,
        {"finalize": "finalize", "human_review": "human_review", "choose_fix": "choose_fix"},
    )
    graph.add_conditional_edges(
        "choose_fix", route_fix,
        {"patch_summary": "patch_summary", "rewrite_sections": "rewrite_sections", "write_summary": "write_summary"},
    )
    graph.add_edge("finalize", END)
    graph.add_edge("human_review", END)
    return graph.compile()


def recursion_limit(settings: Settings) -> int:
    # build_context + (choose_fix + writer + review) per round + final node, with headroom.
    return 3 * settings.max_rounds + 6


def generate_discharge_summary(notes: str, settings: Settings | None = None) -> DischargeState:
    """Run the full graph and return the final state."""
    if not notes or not notes.strip():
        raise ValueError("Clinician notes are empty")
    settings = settings or Settings.from_env()
    app = build_graph(settings)
    return app.invoke({"notes": notes, "rounds": []}, config={"recursion_limit": recursion_limit(settings)})
