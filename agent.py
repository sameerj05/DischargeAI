"""AgentCore Runtime entrypoint for the DischargeAI LangGraph pipeline.

Request:  {"prompt": "<doctor/nurse discharge notes>"}   ("notes" is accepted too)
Response: {"result": "<Going-Home Plan, Markdown>", "status": "...", "flags": [...]}
"""

import asyncio
import os

# Inside AgentCore the runtime's execution role supplies credentials, so no named profile.
# A run must also finish under AgentCore's 15-minute limit for a synchronous request.
os.environ.setdefault("DISCHARGEAI_AWS_PROFILE", "")
os.environ.setdefault("DISCHARGEAI_TIME_BUDGET", "780")

from bedrock_agentcore.runtime import BedrockAgentCoreApp  # noqa: E402

from dischargeai.config import Settings  # noqa: E402
from dischargeai.graph import build_graph, recursion_limit  # noqa: E402
from dischargeai.render import render_markdown  # noqa: E402

settings = Settings.from_env()
graph = build_graph(settings)  # your compiled LangGraph

app = BedrockAgentCoreApp()


@app.entrypoint
async def invoke(payload, context):
    notes = str(payload.get("prompt") or payload.get("notes") or "").strip()
    if not notes:
        return {"error": "Send the discharge notes as 'prompt'."}
    # The graph is synchronous; run it in a thread so the /ping health check keeps answering.
    result = await asyncio.to_thread(
        graph.invoke, {"notes": notes, "rounds": []}, {"recursion_limit": recursion_limit(settings)}
    )
    return {
        "result": render_markdown(result["plan"]),
        "status": result["status"],
        "flags": result.get("flags", []),
    }


if __name__ == "__main__":
    app.run()
