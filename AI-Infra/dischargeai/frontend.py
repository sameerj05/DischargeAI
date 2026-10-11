"""Turn the approved plan into the frontend's `DischargePlan` object (frontend/src/data.ts).

Code only, no model call: the plan was already checked against the notes, so this step just
re-shapes it. Proof quotes are dropped (the patient view never shows them).

Rules from the frontend contract:
- Every checkable item gets an opaque, stable id. Ids are hashes, never drug names, so
  checklist state stores no clinical text. The same plan + salt always gives the same ids.
- Items in the "asNeeded" group are `trackable: false` (no checkbox).
- Group `key`s and ids are language-neutral; translations only change the strings.

Medicines with a clock time (morning, midday, evening, bedtime) go in the frontend's time
groups. Medicines the notes only give a frequency for ("2 times a day") are NOT moved to
made-up times; they get frequency groups ("onceDaily", "twiceDaily", ...) with one checkbox
row per dose. The frontend renders `group.label` from this data, so those groups display as
is; its `MedScheduleKey` type just needs the extra keys added.
"""

from __future__ import annotations

import copy
import hashlib
import re
from typing import Any

from .render import EMERGENCY_LINE, MEDS_INTRO, NO_DATE_LINE, SLOTS

LANGUAGES = ("en", "es", "zh", "ar")
TITLE = "Your Care Plan"
WARNING_HEADING = "Get help RIGHT AWAY for:"

# Internal schedule slot -> (frontend group key, id suffix, doses per day for checkbox rows)
GROUP_MAP: dict[str, tuple[str, str, int]] = {
    "morning": ("morning", "am", 1),
    "midday": ("afternoon", "noon", 1),
    "evening": ("evening", "pm", 1),
    "bedtime": ("bedtime", "hs", 1),
    "once_daily": ("onceDaily", "qd", 1),
    "twice_daily": ("twiceDaily", "bid", 2),
    "three_times_daily": ("threeTimesDaily", "tid", 3),
    "four_times_daily": ("fourTimesDaily", "qid", 4),
    "other_schedule": ("otherSchedule", "oth", 1),
    "as_needed": ("asNeeded", "prn", 1),
}
assert set(GROUP_MAP) == {key for key, _, _ in SLOTS}, "every schedule slot needs a frontend group"

# Group labels per language. The first seven match frontend/src/data.ts GROUP_LABELS exactly.
GROUP_LABELS: dict[str, dict[str, str]] = {
    "en": {"morning": "MORNING", "afternoon": "AFTERNOON", "evening": "EVENING", "bedtime": "BEDTIME",
           "iv": "IV ANTIBIOTIC", "perHospitalList": "TAKE AS YOUR HOSPITAL MEDICINE LIST SAYS",
           "asNeeded": "ONLY WHEN NEEDED", "onceDaily": "ONCE A DAY", "twiceDaily": "2 TIMES A DAY",
           "threeTimesDaily": "3 TIMES A DAY", "fourTimesDaily": "4 TIMES A DAY",
           "otherSchedule": "OTHER SCHEDULES"},
    "es": {"morning": "MAÑANA", "afternoon": "TARDE", "evening": "NOCHE", "bedtime": "AL ACOSTARSE",
           "iv": "ANTIBIÓTICO IV", "perHospitalList": "TÓMELOS SEGÚN SU LISTA DE MEDICAMENTOS DEL HOSPITAL",
           "asNeeded": "SOLO CUANDO SEA NECESARIO", "onceDaily": "UNA VEZ AL DÍA", "twiceDaily": "2 VECES AL DÍA",
           "threeTimesDaily": "3 VECES AL DÍA", "fourTimesDaily": "4 VECES AL DÍA",
           "otherSchedule": "OTROS HORARIOS"},
    "zh": {"morning": "早晨", "afternoon": "下午", "evening": "晚上", "bedtime": "睡前", "iv": "静脉注射抗生素",
           "perHospitalList": "按照您的医院用药清单服用", "asNeeded": "仅在需要时", "onceDaily": "每天 1 次",
           "twiceDaily": "每天 2 次", "threeTimesDaily": "每天 3 次", "fourTimesDaily": "每天 4 次",
           "otherSchedule": "其他服药时间"},
    "ar": {"morning": "الصباح", "afternoon": "بعد الظهر", "evening": "المساء", "bedtime": "قبل النوم",
           "iv": "مضاد حيوي وريدي", "perHospitalList": "تناولها حسب قائمة أدوية المستشفى الخاصة بك",
           "asNeeded": "فقط عند الحاجة", "onceDaily": "مرة واحدة في اليوم", "twiceDaily": "2 مرات في اليوم",
           "threeTimesDaily": "3 مرات في اليوم", "fourTimesDaily": "4 مرات في اليوم",
           "otherSchedule": "مواعيد أخرى"},
}

# Leading status word in a schedule note ("NEW; take for 3 more days only; ...").
_STATUS = re.compile(r"^\s*(NEW|CHANGED|CONTINUED?|RESTART(?:ED)?)\b[\s,;:.\-–—]*", re.I)
# Note parts that belong in the flag chip: how long, or a dose change.
_DURATION = re.compile(r"\bmore (?:days?|weeks?)\b|\b\d+ (?:more )?(?:days?|weeks?)\b|higher dose|lower dose|"
                       r"stop (?:after|on)\b", re.I)


class _Ids:
    """Opaque, stable, unique ids: prefix + 10 hex chars of a salted hash (+ a per-dose suffix)."""

    def __init__(self, salt: str) -> None:
        self.salt = salt
        self.seen: set[str] = set()

    def make(self, prefix: str, *parts: str, suffix: str = "") -> str:
        basis = "|".join([self.salt, prefix, *(re.sub(r"\s+", " ", p.strip().lower()) for p in parts)])
        n = 0
        while True:
            h = hashlib.sha256(f"{basis}|{n}".encode()).hexdigest()[:10]
            line_id = f"{prefix}-{h}" + (f"-{suffix}" if suffix else "")
            if line_id not in self.seen:
                self.seen.add(line_id)
                return line_id
            n += 1


def _sentence(text: str) -> str:
    text = text.strip()
    return text if not text or text.endswith((".", "!", "?", ":")) else text + "."


def _join(*parts: str, sep: str = " ") -> str:
    return sep.join(p.strip() for p in parts if p and p.strip())


def split_note(note: str) -> tuple[str, str]:
    """Split a schedule note into (flag chip text, extra reason text).

    "NEW; take for 3 more days only; finish the full course" -> ("NEW, take for 3 more days only",
    "finish the full course"). "CONTINUE" is dropped: the frontend shows no chip for continued medicines.
    """
    note = note.strip()
    status = ""
    m = _STATUS.match(note)
    if m:
        word = m.group(1).upper()
        status = "NEW" if word == "NEW" else "CHANGED" if word == "CHANGED" else ""
        note = note[m.end():]
    flag_parts, extra = [], []
    for part in (p.strip(" ,.") for p in note.split(";")):
        if part:
            (flag_parts if _DURATION.search(part) else extra).append(part)
    flag = ", ".join(([status] if status else []) + flag_parts)
    return flag, "; ".join(extra)


def _call_doctor_line(text: str) -> str:
    text = _sentence(text)
    if re.match(r"you\b", text, re.I):
        return "Call your doctor if " + text[0].lower() + text[1:]
    return "Call your doctor: " + text


def to_discharge_plan(plan: dict[str, Any], salt: str = "") -> dict[str, Any]:
    """English `DischargePlan` for the frontend. `salt` should be unique per patient record."""
    ids = _Ids(salt)

    groups = []
    for slot, _, _ in SLOTS:
        entries = plan["schedule"].get(slot) or []
        if not entries:
            continue
        key, suffix, doses = GROUP_MAP[slot]
        items = []
        for d in entries:
            flag, extra = split_note(d.get("note", ""))
            reason = _join(d.get("purpose", ""), extra, sep="; ")
            for n in range(1, doses + 1):
                item: dict[str, Any] = {
                    "id": ids.make("med", slot, d["medicine"], suffix=f"{suffix}{n}" if doses > 1 else suffix),
                    "name": d["medicine"],
                    "reason": reason if doses == 1 else _join(f"Dose {n} of {doses}", reason, sep=" – "),
                }
                if flag:
                    item["flag"] = flag
                item["trackable"] = key != "asNeeded"
                items.append(item)
        groups.append({"key": key, "label": GROUP_LABELS["en"][key], "items": items})

    new_meds = [{"name": m["medicine"], "detail": _sentence(m["explanation"])} for m in plan["new_medicines"]]
    new_meds += [{"name": m["medicine"], "detail": _join("CHANGED.", _sentence(m["explanation"]))}
                 for m in plan["changed_medicines"]]

    todos: dict[str, Any] = {
        "labs": [{"id": ids.make("lab", t["task"]), "label": _sentence(t["task"]),
                  **({"detail": d} if (d := _join(_sentence(t["when"]), _sentence(t["why"]))) else {})}
                 for t in plan["tests"]],
        "appointments": [{"id": ids.make("appt", a["who"], a["when"]), "label": a["who"],
                          **({"detail": d} if (d := _join(_sentence(a["when"]), _sentence(a["where"]),
                                                          _sentence(a["why"]))) else {})}
                         for a in plan["appointments"]],
        "careInstructions": [{"id": ids.make("care", s["text"]), "label": _sentence(s["text"])}
                             for s in plan["care_instructions"]],
    }
    if any(not a["date_known"] for a in plan["appointments"]):
        todos["appointmentsNote"] = NO_DATE_LINE

    return {
        "title": TITLE,
        "medications": {"intro": MEDS_INTRO, "groups": groups},
        "newMedicines": new_meds,
        "stoppedMedicines": [{"name": m["medicine"], "detail": _join(f"{m['status']}.", _sentence(m["explanation"]))}
                             for m in plan["stopped_medicines"]],
        "todos": todos,
        "generalInstructions": [_sentence(s["text"]) for s in plan["questions_for_care_team"]]
                               + [_call_doctor_line(s["text"]) for s in plan["call_doctor_if"]],
        "warningSigns": {
            "heading": WARNING_HEADING,
            "signs": [_sentence(s["text"]) for s in plan["get_help_now_if"]],
            "emergencyLine": EMERGENCY_LINE,
        },
        "whyHospitalized": [_sentence(s["text"]) for s in plan["why_in_hospital"]],
    }


# ---- helpers for translating a DischargePlan without touching ids, keys, or flags ----

# String fields a translation may change. Everything else (id, key, trackable) is copied from English.
_TEXT_KEYS = {"title", "intro", "name", "reason", "flag", "detail", "label", "appointmentsNote",
              "heading", "emergencyLine"}
_TEXT_LISTS = {"generalInstructions", "signs", "whyHospitalized"}


def _walk(node: Any, path: tuple, out: list[tuple[tuple, str]]) -> None:
    if isinstance(node, dict):
        is_group = "key" in node and "items" in node
        for k, v in node.items():
            if isinstance(v, str) and k in _TEXT_KEYS and not (is_group and k == "label"):
                if v.strip():  # empty strings (a reason the notes do not give) stay empty
                    out.append((path + (k,), v))
            elif k in _TEXT_LISTS and isinstance(v, list):
                out.extend((path + (k, i), s) for i, s in enumerate(v) if isinstance(s, str) and s.strip())
            elif isinstance(v, (dict, list)):
                _walk(v, path + (k,), out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _walk(v, path + (i,), out)


def text_fields(plan_en: dict[str, Any]) -> list[tuple[tuple, str]]:
    """Every translatable string in an English DischargePlan, as (path, text), in a fixed order."""
    out: list[tuple[tuple, str]] = []
    _walk(plan_en, (), out)
    return out


def with_texts(plan_en: dict[str, Any], lang: str, texts: dict[tuple, str]) -> dict[str, Any]:
    """Copy of the English plan with translated strings put back by path, and group labels for `lang`."""
    plan = copy.deepcopy(plan_en)
    for path, text in texts.items():
        node = plan
        for step in path[:-1]:
            node = node[step]
        node[path[-1]] = text
    for grp in plan["medications"]["groups"]:
        grp["label"] = GROUP_LABELS[lang][grp["key"]]
    return plan


def medicine_names(plan_en: dict[str, Any]) -> list[str]:
    """Medicine names shown in the plan (for translation checks: these must stay as written)."""
    names = [i["name"] for g in plan_en["medications"]["groups"] for i in g["items"]]
    names += [m["name"] for m in plan_en["newMedicines"] + plan_en["stoppedMedicines"]]
    return list(dict.fromkeys(names))
