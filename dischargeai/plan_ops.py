"""Plan structure: sections, stable line IDs, and applying targeted edits.

Every plan item gets an `id` like "schedule.morning.2" or "get_help_now_if.4". Problems are
tied to these IDs, so a fix can touch only the lines that were flagged. IDs never get reused:
a line added later gets the next free number in its section.
"""

from __future__ import annotations

import copy
import re
from typing import Any, Iterator

from .render import SLOTS

SCHEDULE_SECTIONS = tuple(f"schedule.{key}" for key, _, _ in SLOTS)
LIST_SECTIONS = ("why_in_hospital", "new_medicines", "changed_medicines", "stopped_medicines", "tests",
                 "appointments", "care_instructions", "questions_for_care_team", "call_doctor_if",
                 "get_help_now_if")
SECTION_KEYS = ("why_in_hospital",) + SCHEDULE_SECTIONS + LIST_SECTIONS[1:]
TEXT_SECTIONS = ("why_in_hospital", "care_instructions", "questions_for_care_team", "call_doctor_if",
                 "get_help_now_if")
MED_SECTIONS = SCHEDULE_SECTIONS + ("new_medicines", "changed_medicines", "stopped_medicines")
STOP_STATUSES = ("STOPPED", "ON HOLD", "DO NOT TAKE")

# Sections that are rewritten together, because a fix in one usually needs the others.
GROUPS: dict[str, tuple[str, ...]] = {
    "why": ("why_in_hospital",),
    "medicines": MED_SECTIONS,
    "todo": ("tests", "appointments"),
    "care": ("care_instructions",),
    "questions": ("questions_for_care_team",),
    "warnings": ("call_doctor_if", "get_help_now_if"),
}
# Reviewer fact category -> the group where a missing fact belongs.
CATEGORY_GROUP = {"diagnosis": "why", "medication": "medicines", "follow_up": "todo", "test": "todo",
                  "home_care": "care", "activity_diet": "care", "warning_sign": "warnings", "other": "care"}


def fields(section: str) -> tuple[str, ...]:
    if section in TEXT_SECTIONS:
        return ("text",)
    if section in SCHEDULE_SECTIONS:
        return ("medicine", "purpose", "note")
    return {
        "new_medicines": ("medicine", "explanation"),
        "changed_medicines": ("medicine", "explanation"),
        "stopped_medicines": ("medicine", "status", "explanation"),
        "tests": ("task", "when", "why"),
        "appointments": ("who", "when", "where", "why"),
    }[section]


def group_of(section: str) -> str:
    return next(g for g, secs in GROUPS.items() if section in secs)


def _s(value: Any) -> str:
    return str(value).strip() if isinstance(value, (str, int, float)) else ""


def clean_item(section: str, raw: Any) -> dict[str, Any] | None:
    """Validate one model-made item for a section. Returns None if it is unusable."""
    if not isinstance(raw, dict):
        return None
    keys = fields(section)
    item: dict[str, Any] = {k: _s(raw.get(k)) for k in keys}
    if not item[keys[0]]:
        return None
    proof = raw.get("proof")
    item["proof"] = [_s(q) for q in proof if _s(q)] if isinstance(proof, list) else []
    if section == "stopped_medicines" and item["status"] not in STOP_STATUSES:
        return None
    if section == "appointments":
        item["date_known"] = raw.get("date_known") is True
    return item


def clean_list(section: str, raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    return [i for i in (clean_item(section, r) for r in raw) if i]


def get_list(plan: dict[str, Any], section: str) -> list[dict[str, Any]]:
    if section in SCHEDULE_SECTIONS:
        return plan["schedule"][section.split(".", 1)[1]]
    return plan[section]


def set_list(plan: dict[str, Any], section: str, items: list[dict[str, Any]]) -> None:
    if section in SCHEDULE_SECTIONS:
        plan["schedule"][section.split(".", 1)[1]] = items
    else:
        plan[section] = items


def empty_plan() -> dict[str, Any]:
    plan: dict[str, Any] = {s: [] for s in LIST_SECTIONS}
    plan["schedule"] = {key: [] for key, _, _ in SLOTS}
    return plan


def iter_items(plan: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    for section in SECTION_KEYS:
        for item in get_list(plan, section):
            yield section, item


def _next_number(items: list[dict[str, Any]]) -> int:
    nums = [int(m.group(1)) for i in items if (m := re.search(r"\.(\d+)$", str(i.get("id", ""))))]
    return max(nums, default=0) + 1


def assign_ids(plan: dict[str, Any]) -> dict[str, Any]:
    """Give every item without an id the next free id in its section (in place)."""
    for section in SECTION_KEYS:
        items = get_list(plan, section)
        for item in items:
            if not item.get("id"):
                item["id"] = f"{section}.{_next_number(items)}"
    return plan


def find(plan: dict[str, Any], line_id: str) -> tuple[str, int] | None:
    for section in SECTION_KEYS:
        for idx, item in enumerate(get_list(plan, section)):
            if item.get("id") == line_id:
                return section, idx
    return None


def med_key(text: str) -> str:
    words = text.lower().replace("(", " ").split()
    return words[0] if words else ""


def item_med_key(section: str, item: dict[str, Any]) -> str:
    return med_key(item.get("medicine", "")) if section in MED_SECTIONS else ""


def linked_ids(plan: dict[str, Any], flagged: set[str]) -> set[str]:
    """Lines about the same medicine as a flagged medicine line. Fixing a medicine often
    needs its schedule entry and its "new medicines" entry changed together."""
    keys = {item_med_key(s, i) for s, i in iter_items(plan) if i["id"] in flagged} - {""}
    return {i["id"] for s, i in iter_items(plan) if item_med_key(s, i) in keys} - flagged


def apply_edits(plan: dict[str, Any], edits: list[dict[str, Any]], allowed: set[str]
                ) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Apply writer edits to a copy of the plan. Only `allowed` lines may be replaced, deleted,
    or moved; adds are always allowed (they fix missing facts). Returns (plan, applied, rejected).
    """
    new = copy.deepcopy(plan)
    applied: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []

    def reject(edit: dict[str, Any], why: str) -> None:
        rejected.append({**edit, "rejected_because": why})

    for edit in edits:
        if not isinstance(edit, dict):
            continue
        action, line_id, target = _s(edit.get("action")), _s(edit.get("line_id")), _s(edit.get("section"))
        if action in ("replace", "delete", "move"):
            if line_id not in allowed:
                reject(edit, "line was not flagged")
                continue
            where = find(new, line_id)
            if not where:
                reject(edit, "no such line")
                continue
            section, idx = where
            items = get_list(new, section)
            if action == "delete":
                items.pop(idx)
            elif action == "replace":
                item = clean_item(section, edit.get("item"))
                if not item:
                    reject(edit, f"item is not a valid {section} item")
                    continue
                items[idx] = {**item, "id": line_id}
            else:  # move
                if target not in SECTION_KEYS or target == section:
                    reject(edit, "invalid target section")
                    continue
                source = items[idx]
                raw = edit.get("item") if isinstance(edit.get("item"), dict) else (
                    source if fields(target) == fields(section) else None)
                item = clean_item(target, raw)
                if not item:
                    reject(edit, f"moving to {target} needs a valid {target} item")
                    continue
                items.pop(idx)
                dest = get_list(new, target)
                dest.append({**item, "id": f"{target}.{_next_number(dest)}"})
        elif action == "add":
            if target not in SECTION_KEYS:
                reject(edit, "invalid target section")
                continue
            item = clean_item(target, edit.get("item"))
            if not item:
                reject(edit, f"item is not a valid {target} item")
                continue
            dest = get_list(new, target)
            dest.append({**item, "id": f"{target}.{_next_number(dest)}"})
        else:
            reject(edit, "unknown action")
            continue
        applied.append(edit)
    return new, applied, rejected


def merge_sections(base: dict[str, Any], replacement: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Replace whole sections of `base` with new items, giving the new items fresh ids."""
    new = copy.deepcopy(base)
    for section, items in replacement.items():
        set_list(new, section, [{k: v for k, v in i.items() if k != "id"} for i in items])
    for section in replacement:
        items = get_list(new, section)
        for n, item in enumerate(items, start=1):
            item["id"] = f"{section}.{n}"
    return new
