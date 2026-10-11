"""Proof checking: the raw clinician notes are the only accepted proof.

Every item the writer puts in the plan carries `proof`: exact quotes from the notes. Code
checks here that each quote really is in the notes. The reviewer then checks that the
quotes support everything the line says. Together this means nothing reaches the patient
unless someone can point to the words in the notes it came from.
"""

from __future__ import annotations

import re
from typing import Any

MIN_PROOF_WORDS = 2     # one-word quotes ("NEW", "daily") match almost anywhere; "no alcohol" is fine
NOTES_MATCH = 0.85      # share of 4-word chunks that must match, to allow tiny copy drift


def normalize(text: str) -> str:
    """Lowercase words and numbers only; keeps decimals like 2.5 and ratios like 875/125."""
    text = re.sub(r"[^\w\s./%]", " ", text.lower())
    text = re.sub(r"(?<!\d)\.|\.(?!\d)", " ", text)
    return " ".join(text.split())


def quote_in_text(quote: str, text: str, threshold: float) -> bool:
    """True if `quote` appears in `text`, ignoring case, punctuation, and small drift."""
    q, t = normalize(quote), normalize(text)
    if len(q.split()) < 2:
        return False
    if q in t:
        return True
    words = q.split()
    shingles = [" ".join(words[i:i + 4]) for i in range(max(1, len(words) - 3))]
    return sum(s in t for s in shingles) / len(shingles) >= threshold


def _whole_lines(notes: str) -> set[str]:
    """Every line of the notes, normalized. A short quote that is a whole line (for example a
    one-word bullet like "- Hypertension" in a diagnosis list) is real proof, not a fragment."""
    return {n for n in (normalize(line) for line in notes.splitlines()) if n}


def proof_problems(entries: list[dict[str, Any]], notes: str) -> list[dict[str, Any]]:
    """Check every plan line's proof quotes against the notes.

    `entries` come from render.proof_entries. Returns one issue per line with no proof, and
    one per quote that is not in the notes. Each issue names the line it is about.
    """
    issues: list[dict[str, Any]] = []
    lines = _whole_lines(notes)

    def add(text: str, e: dict[str, Any]) -> None:
        issues.append({"text": text, "lines": [e["id"]], "kind": "line"})

    for e in entries:
        line = e["text"]
        quotes = [q.strip() for q in e["proof"] if q and q.strip()]
        if not quotes:
            add(f"NO PROOF: \"{line}\" -- add exact quotes from the notes that prove it, or remove it.", e)
            continue
        for q in quotes:
            if normalize(q) in lines:
                continue  # a whole line of the notes, however short
            if len(normalize(q).split()) < MIN_PROOF_WORDS:
                add(f"PROOF TOO SHORT: \"{line}\" -- quote \"{q}\" is under {MIN_PROOF_WORDS} words. "
                    "Quote more of the notes, or quote the whole line it is on.", e)
            elif not quote_in_text(q, notes, NOTES_MATCH):
                add(f"PROOF NOT IN NOTES: \"{line}\" -- quote \"{q}\" is not in the notes word for "
                    "word. Copy the notes' exact words, or remove what you cannot prove.", e)
    return issues


def lines_matching(quote: str, entries: list[dict[str, Any]]) -> list[str]:
    """IDs of the plan lines a reviewer quote comes from."""
    return [e["id"] for e in entries if quote_in_text(quote, e["text"], 0.6)]


URGENT_HEADER = re.compile(
    r"(seek|get)\s+(urgent|emergency|immediate)|return\s+(immediately|to the (er|ed|emergency))|"
    r"go to the (er|ed|emergency)|call 911|urgent (evaluation|medical attention|care)",
    re.IGNORECASE,
)
_BULLET = re.compile(r"^\s*([-*•]|\d+[.)])\s+")


def urgent_blocks(notes: str) -> list[str]:
    """Bullet lists that follow an urgent/emergency header line, e.g. "Seek urgent medical
    attention for:" followed by "- Chest pain." lines. Returned as normalized text."""
    blocks: list[str] = []
    lines = notes.splitlines()
    for i, line in enumerate(lines):
        if not URGENT_HEADER.search(line) or _BULLET.match(line):
            continue
        items = []
        for nxt in lines[i + 1:]:
            if _BULLET.match(nxt):
                items.append(nxt)
            elif nxt.strip() and items:
                break  # the list has ended
        if items:
            blocks.append(normalize("\n".join(items)))
    return blocks


def urgency_problems(entries: list[dict[str, Any]], notes: str) -> list[dict[str, Any]]:
    """A 'call your doctor' line proved by an urgent/emergency list (or its header) was made
    less urgent than the notes say."""
    blocks = urgent_blocks(notes)
    if not blocks:
        return []
    issues = []
    for e in entries:
        if e["section"] != "call_doctor_if":
            continue
        if any(URGENT_HEADER.search(q) or any(quote_in_text(q, b, NOTES_MATCH) for b in blocks)
               for q in e["proof"] if q.strip()):
            issues.append({"text": f"URGENCY LOWERED: \"{e['text']}\" -- the notes list this under urgent/"
                                   "emergency care. Move it to get_help_now_if.",
                           "lines": [e["id"]], "kind": "line"})
    return issues
