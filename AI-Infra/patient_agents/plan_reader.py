"""Read a Going-Home Plan Markdown file: its lines, and its medicine lists.

The medicine lists drive the chatbot's "should I take this?" answers in code, so a model
never decides on its own whether a patient takes a medicine.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

TAKE = "take"            # scheduled medicine: take it as listed
AS_NEEDED = "as_needed"  # take only when needed, as listed
STOPPED = "stopped"      # STOPPED / ON HOLD / DO NOT TAKE

_BOXES = re.compile(r"^-\s+(\[ \]\s*)+")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_STOP_STATUS = re.compile(r"\b(STOPPED|ON HOLD|DO NOT TAKE)\b")
_UNCLEAR = re.compile(r"name not clear|not in your notes|not listed|ask your care team|not stated", re.I)


@dataclass(frozen=True)
class Medicine:
    name: str          # e.g. "Atorvastatin"
    line: str          # the plan line, cleaned for display
    status: str        # TAKE | AS_NEEDED | STOPPED
    unclear: bool      # the plan itself says the name or dose is not clear
    dose: str = ""     # the dose part of the entry, e.g. "80 mg" (empty if none)
    aliases: tuple[str, ...] = ()  # other names on the line, e.g. "(maintenance inhaler)", "(NSAIDs)"


@dataclass
class Plan:
    text: str
    medicines: list[Medicine]

    def find(self, asked: str) -> list[Medicine]:
        """Plan medicines that match the name the patient asked about."""
        a = _norm(asked)
        if len(a) < 3:
            return []
        hits = []
        for m in self.medicines:
            for n in (_norm(x) for x in (m.name, *m.aliases)):
                if not n:
                    continue
                first = n.split()[0]
                if (a == n or (len(a) >= 4 and (a in n or n in a))
                        or (len(first) >= 4 and first not in _GENERIC_FIRST and re.search(rf"\b{re.escape(first)}\b", a))):
                    hits.append(m)
                    break
        return hits

    def mentions(self, asked: str) -> bool:
        """True if the asked name appears anywhere in the plan's medicine section, even when it
        could not be tied to one entry. Then the safe answer is 'ask your care team', not 'no'."""
        a = _norm(asked)
        return len(a) >= 4 and a in _norm(_medicine_section(self.text))

    def names(self) -> list[str]:
        return list(dict.fromkeys(m.name for m in self.medicines))


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9\s-]", " ", text.lower()).split())


# First words that are too generic to match on alone ("your everyday inhaler" vs "your pills").
_GENERIC_FIRST = {"your", "other", "home", "daily", "everyday", "rescue", "previous", "blood", "pain", "water"}
_NOT_A_NAME = re.compile(r"\b(not|dose|clear|listed|stated|notes|mg|mcg)\b|\d", re.I)


def _aliases(head: str) -> tuple[str, ...]:
    """Names in parentheses on a medicine line, skipping notes like '(dose not stated)'."""
    parts = [p.strip() for group in re.findall(r"\(([^()]*)\)", head) for p in re.split(r"[,;]", group)]
    return tuple(p for p in parts if len(p) >= 3 and not _NOT_A_NAME.search(p))


def _medicine_section(text: str) -> str:
    out, inside = [], False
    for line in text.splitlines():
        if line.startswith("## "):
            inside = line[3:].strip().lower().startswith("your medication list")
        elif inside:
            out.append(line)
    return "\n".join(out)


def _name_from(text: str) -> str:
    """'Atorvastatin 80 mg, nightly' -> 'Atorvastatin'; 'NSAIDs (pain medicines)' -> 'NSAIDs'.
    Keeps names that have no dose."""
    text = text.split("(")[0].split(",")[0].strip()
    m = re.match(r"^(.*?)(?=\s+\d)", text)
    return (m.group(1) if m else text).strip(" -–—")


def _split_names(text: str) -> list[str]:
    """'Ibuprofen/other NSAIDs' -> ['Ibuprofen', 'NSAIDs']."""
    parts = re.split(r"\s*/\s*|\s+and\s+|\s+or\s+", _name_from(text))
    return [re.sub(r"^(other|any)\s+", "", p, flags=re.I).strip() for p in parts if p.strip()]


def read_plan(path: Path) -> Plan:
    text = path.read_text(encoding="utf-8")
    return Plan(text=text, medicines=parse_medicines(text))


def parse_medicines(text: str) -> list[Medicine]:
    meds: list[Medicine] = []
    in_meds = False
    sub = ""
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("## "):
            in_meds = line[3:].strip().lower().startswith("your medication list")
            sub = ""
            continue
        if not in_meds:
            continue
        if line.startswith("### "):
            sub = line[4:].strip()
            continue
        if not line.startswith("- "):
            continue
        shown = _BOXES.sub("", line).removeprefix("- ").strip()
        unclear = bool(_UNCLEAR.search(line))
        if sub.lower() == "stopped medicines":
            bold = _BOLD.search(line)
            head = bold.group(1) if bold else shown.lstrip("❌ ").split(" – ")[0]
            for name in _split_names(head):
                meds.append(Medicine(name, shown.replace("**", "").lstrip("❌ ").strip(), STOPPED, unclear,
                                     _dose_of(head), _aliases(head)))
        elif sub.lower() in ("new medicines", "changed medicines"):
            continue  # same medicines as the schedule, with explanations; the schedule decides
        else:
            status = AS_NEEDED if sub.upper().startswith("ONLY WHEN") else TAKE
            head = shown.split(" – ")[0]
            if _STOP_STATUS.search(shown.split(" – ")[1] if " – " in shown else ""):
                status = STOPPED if "then STOP" not in shown else status
            meds.append(Medicine(_name_from(head), shown, status, unclear, _dose_of(head), _aliases(head)))
    return meds


def _dose_of(head: str) -> str:
    """'Atorvastatin 80 mg' -> '80 mg'; 'Amoxicillin-clavulanate 875/125 mg' -> '875/125 mg'."""
    m = re.search(r"\d[\d.,/]*\s*(mg|mcg|g|gram|grams|ml|units?|puffs?|hr|%)?(/\d+\s*hr)?", head, re.I)
    return m.group(0).strip() if m else ""
