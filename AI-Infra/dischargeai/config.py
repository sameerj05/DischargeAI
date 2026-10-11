"""Runtime settings, overridable with environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass

# Both models were verified as invokable from the workshop role in us-west-2.
# The "us." prefix is a geographic inference profile: requests stay in US regions.
DEFAULT_CONTEXT_MODEL = "us.anthropic.claude-sonnet-4-6"
DEFAULT_WRITER_MODEL = "us.anthropic.claude-sonnet-4-6"
DEFAULT_REVIEWER_MODEL = "us.anthropic.claude-sonnet-4-6"


@dataclass(frozen=True)
class Settings:
    aws_profile: str | None
    aws_region: str
    context_model: str
    writer_model: str
    reviewer_model: str
    max_rounds: int
    max_grade_level: float
    # Amazon Comprehend Medical: "auto" uses it when the credentials allow it and continues
    # without it otherwise; "on" fails the run if it is unavailable; "off" skips it.
    comprehend_mode: str = "auto"
    comprehend_region: str = "us-west-2"
    # Seconds the whole run may take (0 = no limit). A new round only starts if it is
    # expected to finish in time; otherwise the best draft so far goes to human review.
    time_budget_seconds: int = 0

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            aws_profile=os.environ.get("DISCHARGEAI_AWS_PROFILE", "") or None,
            aws_region=os.environ.get("DISCHARGEAI_AWS_REGION", "us-west-2"),
            context_model=os.environ.get("DISCHARGEAI_CONTEXT_MODEL", DEFAULT_CONTEXT_MODEL),
            writer_model=os.environ.get("DISCHARGEAI_WRITER_MODEL", DEFAULT_WRITER_MODEL),
            reviewer_model=os.environ.get("DISCHARGEAI_REVIEWER_MODEL", DEFAULT_REVIEWER_MODEL),
            max_rounds=int(os.environ.get("DISCHARGEAI_MAX_ROUNDS", "4")),
            # Flesch-Kincaid grade of the plain words (parenthesized medical terms are not scored).
            # 5.9 = no higher than 5th grade.
            max_grade_level=float(os.environ.get("DISCHARGEAI_MAX_GRADE", "5.9")),
            comprehend_mode=_comprehend_mode(os.environ.get("DISCHARGEAI_COMPREHEND", "auto")),
            comprehend_region=os.environ.get(
                "DISCHARGEAI_COMPREHEND_REGION", os.environ.get("DISCHARGEAI_AWS_REGION", "us-west-2")
            ),
            time_budget_seconds=int(os.environ.get("DISCHARGEAI_TIME_BUDGET", "0")),
        )


def _comprehend_mode(value: str) -> str:
    value = value.strip().lower()
    if value not in ("auto", "on", "off"):
        raise ValueError(f"DISCHARGEAI_COMPREHEND must be auto, on, or off (got {value!r})")
    return value
