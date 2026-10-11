"""Deterministic checks that do not depend on an LLM's opinion."""

from __future__ import annotations

import re

import textstat

from .render import TEMPLATE_LINES

_PREFIX = re.compile(r"^((\[ \]\s*)+|X |-|\*)\s*")


def _body_text(summary: str) -> str:
    """Patient-facing sentences only: no headings, checkboxes, or fixed template lines."""
    sentences = []
    for line in summary.splitlines():
        line = line.strip()
        if not line or line in TEMPLATE_LINES:
            continue
        if line.upper() == line:  # ALL-CAPS headings like "MORNING"
            continue
        line = _PREFIX.sub("", line).strip()
        sentences.append(line if line.endswith((".", "!", "?")) else line + ".")
    return " ".join(sentences)


def grade_level(summary: str, protected_terms: list[str]) -> float:
    """Flesch-Kincaid grade of the summary body.

    The score measures the plain words the patient reads. Medical terms that sit in
    parentheses after plain words ("fluid in your lungs (pulmonary edema)") are there on
    purpose, so parenthesized text is left out. Medicine names and diagnoses must stay exact
    (e.g. "empagliflozin"), and their syllable counts would unfairly push the score up, so
    they are replaced with a one-word stand-in before scoring.
    """
    text = re.sub(r"\([^()]*\)", " ", _body_text(summary))
    text = re.sub(r"\([^()]*\)", " ", text)  # second pass for one level of nesting
    for term in sorted({t for t in protected_terms if t.strip()}, key=len, reverse=True):
        text = re.sub(re.escape(term), "pill", text, flags=re.IGNORECASE)
    if not text.strip():
        return 0.0
    return float(textstat.flesch_kincaid_grade(text))


def missing_terms(summary: str, required_terms: list[str]) -> list[str]:
    """Required literal terms (e.g. medicine names) that do not appear in the summary."""
    lowered = summary.lower()
    return [t for t in required_terms if t.strip() and t.lower() not in lowered]
