"""Sensitive content the patient plan must never contain: illegal or recreational drug use
and sexual history.

The prompts tell every agent to leave these out. This module is the code-level guard behind
the prompts: a plan that mentions them fails review, the reviewer can never demand them as
"missing", and the final output is scrubbed as a last line of defense.

A medicine the patient must take at home is still listed (name, dose, timing), even a
prescribed opioid such as a fentanyl patch, so plain "fentanyl" is only allowed on
medicine lines. Future-activity instructions ("no sexual activity for 2 weeks after
surgery") are care instructions, not sexual history, and are not blocked.
"""

from __future__ import annotations

import copy
import re
from typing import Any

_I = re.IGNORECASE

DRUG_USE = [
    re.compile(p, _I) for p in (
        r"\b(iv|intravenous|injection|injected|injecting|illicit|illegal|recreational|street)\s+drugs?\b",
        r"\bdrugs?\s+(use|user|users|abuse|misuse|habit|history)\b",
        r"\bus(e|es|ed|ing)\s+(illegal\s+|street\s+)?drugs\b",
        r"\bdrugs?\s+(through|with|by)\s+(a\s+)?needles?\b",
        r"\bsubstance\s+(use|abuse|misuse)\b",
        r"\b(ivdu|pwid|pwud|sud|oud)\b",
        r"\bopioid\s+(use|abuse|misuse|addiction|dependence)\b",
        r"\baddict(ion|ions|ed)?\b",
        r"\b(cocaine|crack|heroine?|methamphetamines?|meth|ecstasy|mdma|pcp|speedball)\b",
        r"\btrack\s+marks\b",
        r"\b(illicit|street|non-?prescribed|recreational)\s+(fentanyl|opioids?)\b",
        r"\b(fentanyl|opioid)\s+(use|abuse|misuse|overdose)\b",
        r"\busing\s+fentanyl\b",
    )
]
SEXUAL_HISTORY = [
    re.compile(p, _I) for p in (
        r"\bsexual\s+(history|partners?|orientation|practices?|behaviou?rs?|contacts?|encounters?)\b",
        r"\bsexually\s+(active|transmitted)\b",
        r"\bsex\s+(partners?|work|worker|workers|history)\b",
        r"\b(sti|stis|std|stds|msm)\b",
        r"\bmen who have sex with men\b",
        r"\bunprotected\s+(sex|intercourse)\b",
        r"\b(multiple|new|number of)\s+(sexual\s+)?partners\b",
    )
]
FENTANYL = re.compile(r"\bfentanyl\b", _I)
# Lines where a prescribed medicine name may appear.
MEDICINE_LINE_SECTIONS_PREFIX = ("schedule.", "new_medicines", "changed_medicines")


def find_terms(text: str, section: str = "") -> list[str]:
    """Sensitive phrases found in `text`. Plain 'fentanyl' only counts outside medicine lines."""
    hits = [m.group(0) for pat in DRUG_USE + SEXUAL_HISTORY for m in pat.finditer(text)]
    if FENTANYL.search(text) and not section.startswith(MEDICINE_LINE_SECTIONS_PREFIX):
        hits.append("fentanyl")
    return list(dict.fromkeys(h.lower() for h in hits))


def is_sensitive_fact(text: str) -> bool:
    """For reviewer 'missing fact' entries: True if the fact is about drug use or sexual history.
    Plain medicine names are not enough (a prescribed fentanyl patch is a real medicine)."""
    return any(p.search(text) for p in DRUG_USE + SEXUAL_HISTORY)


def sensitive_problems(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One issue per plan line that mentions drug use or sexual history."""
    issues = []
    for e in entries:
        terms = find_terms(e["text"], e["section"])
        if terms:
            issues.append({
                "text": f"SENSITIVE, remove it: \"{e['text']}\" -- mentions {', '.join(terms)}. Never mention "
                        "illegal drug use or sexual history anywhere in the plan, not even as a diagnosis.",
                "lines": [e["id"]], "kind": "line",
            })
    return issues


def redact_plan(plan: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Last line of defense: drop any line that still mentions drug use or sexual history."""
    from .plan_ops import SECTION_KEYS, fields, get_list, set_list  # local import: avoid a cycle

    new = copy.deepcopy(plan)
    removed: list[str] = []
    for section in SECTION_KEYS:
        keep = []
        for item in get_list(new, section):
            text = " ".join(str(item.get(k, "")) for k in fields(section))
            if find_terms(text, section):
                removed.append(text)
            else:
                keep.append(item)
        set_list(new, section, keep)
    return new, removed


def filter_entities(cm: dict[str, Any] | None) -> dict[str, Any] | None:
    """Comprehend Medical output for the writer, without social/behavioral entities and without
    any entity that names drug use or sexual history."""
    if not cm or cm.get("status") != "ok":
        return cm
    out = {k: v for k, v in cm.items() if k != "social"}
    for key in ("medications", "conditions", "tests_treatments"):
        out[key] = [e for e in cm.get(key, []) if not is_sensitive_fact(e.get("text", ""))
                    and not re.search(r"\b(cocaine|crack|heroine?|methamphetamines?|meth)\b",
                                      e.get("text", ""), _I)]
    return out
