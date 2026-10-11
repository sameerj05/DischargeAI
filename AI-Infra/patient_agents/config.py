"""Settings for the standalone patient agents, from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-6"


@dataclass(frozen=True)
class AgentSettings:
    aws_profile: str | None
    aws_region: str
    chat_model: str
    translate_model: str

    @classmethod
    def from_env(cls) -> "AgentSettings":
        return cls(
            # Same AWS settings as the pipeline, so one profile works for everything.
            aws_profile=os.environ.get("DISCHARGEAI_AWS_PROFILE", "healthhack") or None,
            aws_region=os.environ.get("DISCHARGEAI_AWS_REGION", "us-west-2"),
            chat_model=os.environ.get("PATIENT_CHAT_MODEL", DEFAULT_MODEL),
            translate_model=os.environ.get("PATIENT_TRANSLATE_MODEL", DEFAULT_MODEL),
        )
