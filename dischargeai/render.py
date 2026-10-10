"""Turn the writer's structured plan into the patient-facing "Going-Home Plan" checklist.

Formatting lives in code, not in the prompt, so every patient gets the same layout and a
web or PDF front end can render the same plan JSON differently later.

Every plan item carries `proof` (quotes from the notes). The patient view hides it; the
review view shows it under each line so the reviewer can check line against proof.
"""

from __future__ import annotations

from typing import Any, Iterator

# (key, heading, boxes per item). Clock-time slots are only used when the notes give a time.
# Otherwise medicines are grouped by how often they are taken, so nothing is assumed.
SLOTS: list[tuple[str, str, int]] = [
    ("morning", "MORNING", 1),
    ("midday", "MIDDAY", 1),
    ("evening", "EVENING", 1),
    ("bedtime", "BEDTIME", 1),
    ("once_daily", "ONCE A DAY", 1),
    ("twice_daily", "2 TIMES A DAY", 2),
    ("three_times_daily", "3 TIMES A DAY", 3),
    ("four_times_daily", "4 TIMES A DAY", 4),
    ("other_schedule", "OTHER SCHEDULES", 1),
    ("as_needed", "ONLY WHEN YOU NEED IT", 1),
]
TIME_SLOTS = ("morning", "midday", "evening", "bedtime")
FREQUENCY_SLOTS = ("once_daily", "twice_daily", "three_times_daily", "four_times_daily")

# Fixed template text added by code. The reviewer is told these are not claims from the notes.
MEDS_INTRO = "These are all the medicines you should take now."
NO_DATE_LINE = "If you do not have a date for a visit yet, call the office to set one up."
EMERGENCY_LINE = "If it feels like an emergency, call 911."
TEMPLATE_LINES = [MEDS_INTRO, NO_DATE_LINE, EMERGENCY_LINE]

# One rendered row: ("heading" | "template" | "item", text, proof quotes, line id, section key)
Row = tuple[str, str, list[str], str, str]


def _join(*parts: str, sep: str = " - ") -> str:
    return sep.join(p.strip() for p in parts if p and p.strip())


def _sentence(text: str) -> str:
    text = text.strip()
    return text if not text or text.endswith((".", "!", "?")) else text + "."


def rows(plan: dict[str, Any]) -> Iterator[Row]:
    def heading(title: str) -> Row:
        return ("heading", title, [], "", "")

    yield heading("YOUR GOING-HOME PLAN")

    if plan["why_in_hospital"]:
        yield heading("WHY YOU WERE IN THE HOSPITAL")
        for s in plan["why_in_hospital"]:
            yield ("item", f"- {_sentence(s['text'])}", s["proof"], s.get("id", ""), "why_in_hospital")

    schedule = plan["schedule"]
    if any(schedule[key] for key, _, _ in SLOTS):
        yield heading("YOUR MEDICINE CHECKLIST")
        yield ("template", MEDS_INTRO, [], "", "")
        for key, title, boxes in SLOTS:
            if schedule[key]:
                yield heading(title)
                for d in schedule[key]:
                    yield ("item", f"{'[ ] ' * boxes}{_join(d['medicine'], d['purpose'], d['note'])}", d["proof"],
                           d.get("id", ""), f"schedule.{key}")

    for key, title in (("new_medicines", "NEW MEDICINES"), ("changed_medicines", "CHANGED MEDICINES")):
        if plan[key]:
            yield heading(title)
            for m in plan[key]:
                yield ("item", f"- {_join(m['medicine'], _sentence(m['explanation']), sep=': ')}", m["proof"],
                       m.get("id", ""), key)

    if plan["stopped_medicines"]:
        yield heading("STOPPED MEDICINES - DO NOT TAKE THESE")
        for m in plan["stopped_medicines"]:
            yield ("item", f"X  {m['medicine']} - {m['status']}. {_sentence(m['explanation'])}".rstrip(), m["proof"],
                   m.get("id", ""), "stopped_medicines")

    if plan["tests"] or plan["appointments"] or plan["care_instructions"]:
        yield heading("THINGS FOR YOU TO DO")
        if plan["tests"]:
            yield heading("TESTS")
            for t in plan["tests"]:
                yield ("item", f"[ ] {_sentence(_join(t['task'], t['when']))} {_sentence(t['why'])}".rstrip(),
                       t["proof"], t.get("id", ""), "tests")
        if plan["appointments"]:
            yield heading("APPOINTMENTS")
            for a in plan["appointments"]:
                yield ("item", f"[ ] {_sentence(_join(a['who'], a['when'], a['where'], a['why']))}", a["proof"],
                       a.get("id", ""), "appointments")
            if any(not a["date_known"] for a in plan["appointments"]):
                yield ("template", NO_DATE_LINE, [], "", "")
        if plan["care_instructions"]:
            yield heading("INSTRUCTIONS FOR YOUR CARE")
            for s in plan["care_instructions"]:
                yield ("item", f"[ ] {_sentence(s['text'])}", s["proof"], s.get("id", ""), "care_instructions")

    for key, title, prefix in (("questions_for_care_team", "QUESTIONS TO ASK YOUR CARE TEAM", "[ ] "),
                               ("call_doctor_if", "CALL YOUR DOCTOR IF", "- ")):
        if plan[key]:
            yield heading(title)
            for s in plan[key]:
                yield ("item", f"{prefix}{_sentence(s['text'])}", s["proof"], s.get("id", ""), key)

    yield heading("GET HELP RIGHT AWAY IF")
    for s in plan["get_help_now_if"]:
        yield ("item", f"- {_sentence(s['text'])}", s["proof"], s.get("id", ""), "get_help_now_if")
    yield ("template", EMERGENCY_LINE, [], "", "")


def render_plan(plan: dict[str, Any]) -> str:
    """What the patient sees."""
    out: list[str] = []
    for kind, text, _, _, _ in rows(plan):
        if kind == "heading" and out:
            out.append("")
        out.append(text)
    return "\n".join(out)


def render_review(plan: dict[str, Any]) -> str:
    """What the reviewer sees: every patient line followed by its proof quotes."""
    out: list[str] = []
    for kind, text, proof, line_id, _ in rows(plan):
        if kind == "heading":
            out.extend(["", f"## {text}"])
        elif kind == "template":
            out.append(f"{text}    (fixed template line added by code)")
        else:
            out.append(f"[{line_id}] {text}" if line_id else text)
            out.append("    PROOF: " + (" | ".join(f'"{q}"' for q in proof) if proof else "(none given)"))
    return "\n".join(out).strip()


def proof_entries(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """Every writer-made line: {"id", "section", "text" (as the patient sees it), "proof"}."""
    return [{"id": line_id, "section": section, "text": text, "proof": proof}
            for kind, text, proof, line_id, section in rows(plan) if kind == "item"]


def render_markdown(plan: dict[str, Any]) -> str:
    """Patient-facing Markdown in the "Your Going-Home Plan" layout. Same content as render_plan."""
    out: list[str] = ["# Your Going-Home Plan"]

    def section(title: str, level: int = 2) -> None:
        out.extend(["", f"{'#' * level} {title}"])

    def dash(*parts: str) -> str:
        return " – ".join(p.strip() for p in parts if p and p.strip())

    if plan["why_in_hospital"]:
        section("Why you were in the hospital")
        out.extend(f"- {_sentence(s['text'])}" for s in plan["why_in_hospital"])

    schedule = plan["schedule"]
    if any(schedule[key] for key, _, _ in SLOTS):
        section("Your medication list")
        out.append(MEDS_INTRO)
        for key, title, boxes in SLOTS:
            if schedule[key]:
                section(title, 3)
                extra = "[ ] " * (boxes - 1)
                out.extend(f"- [ ] {extra}{dash(d['medicine'], d['purpose'], d['note'])}" for d in schedule[key])

    for key, title in (("new_medicines", "New medicines"), ("changed_medicines", "Changed medicines")):
        if plan[key]:
            section(title, 3)
            out.extend(f"- **{m['medicine']}** – {_sentence(m['explanation'])}" for m in plan[key])

    if plan["stopped_medicines"]:
        section("Stopped medicines", 3)
        out.extend(f"- ❌ **{m['medicine']}** – {m['status']}. {_sentence(m['explanation'])}".rstrip()
                   for m in plan["stopped_medicines"])

    if plan["tests"] or plan["appointments"]:
        section("Things for you to do")
        if plan["tests"]:
            section("Labs and tests", 3)
            out.extend(f"- [ ] {_sentence(dash(t['task'], t['when']))} {_sentence(t['why'])}".rstrip()
                       for t in plan["tests"])
        if plan["appointments"]:
            section("Appointments", 3)
            out.extend(f"- [ ] {_sentence(dash(a['who'], a['when'], a['where'], a['why']))}"
                       for a in plan["appointments"])
            if any(not a["date_known"] for a in plan["appointments"]):
                out.extend(["", NO_DATE_LINE])

    if plan["care_instructions"]:
        section("Instructions for your care")
        out.extend(f"- [ ] {_sentence(s['text'])}" for s in plan["care_instructions"])

    if plan["questions_for_care_team"]:
        section("Questions to ask your care team")
        out.extend(f"- [ ] {_sentence(s['text'])}" for s in plan["questions_for_care_team"])

    if plan["call_doctor_if"]:
        section("Call your doctor if")
        out.extend(f"- {_sentence(s['text'])}" for s in plan["call_doctor_if"])

    section("Get help RIGHT AWAY for:")
    out.extend(f"- {_sentence(s['text'])}" for s in plan["get_help_now_if"])
    out.extend(["", EMERGENCY_LINE])
    return "\n".join(out) + "\n"
