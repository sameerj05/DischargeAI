"""AgentCore Runtime entrypoint for DischargeAI.

Payload:  {"notes": "<compiled clinician notes>"}
Response: {"status", "flags", "summary", "plan"}
"""

from __future__ import annotations

import os

from bedrock_agentcore.runtime import BedrockAgentCoreApp

# The runtime has no named AWS profile; an empty value makes boto3 use the execution role.
os.environ.setdefault("DISCHARGEAI_AWS_PROFILE", "")

from dischargeai.config import Settings  # noqa: E402
from dischargeai.graph import generate_discharge_summary  # noqa: E402

app = BedrockAgentCoreApp()

_settings = Settings.from_env()


@app.entrypoint
def invoke(payload: dict, context=None) -> dict:
    if not isinstance(payload, dict):
        return {"error": "Payload must be an object containing notes"}
    notes = payload.get("notes")
    if not isinstance(notes, str) or not notes.strip():
        return {"error": "notes must be a non-empty string"}
    state = generate_discharge_summary(notes, _settings)
    return {
        "status": state.get("status"),
        "flags": state.get("flags", []),
        "summary": state.get("summary"),
        "plan": state.get("plan"),
    }


if __name__ == "__main__":
    app.run()
