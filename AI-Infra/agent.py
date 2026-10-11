"""AgentCore Runtime entrypoint for the DischargeAI LangGraph pipeline.

Request:  {"prompt": "<doctor/nurse discharge notes>"}   ("notes" is accepted too)
          Optional "languages": codes to translate into (default ["es", "zh", "ar"]; [] for English only).
Response: {
  "result": "<Going-Home Plan, Markdown>",
  "status": "approved" | ...,
  "flags": [...],
  "review": {"rounds": <n>, "problems": [<what still failed review, when status is needs_human_review>]},
  "record": {"createdAt": <epoch ms>, "byLang": {"en": DischargePlan, "es": ..., "zh": ..., "ar": ...}},
  "translations": {"es": {"status": "verified" | "needs_review" | "failed", "problems": [...]}, ...}
}
`record` is the frontend's DischargeRecord (frontend/src/data.ts). A language whose translation
failed is left out of byLang (never filled with English) and reported in "translations".
"""

import asyncio
import hashlib
import os
import time

# Inside AgentCore the runtime's execution role supplies credentials, so no named profile.
# A synchronous request must finish under AgentCore's 15-minute limit: the graph gets 10 minutes,
# leaving time for the translations, which run in parallel after it.
os.environ.setdefault("DISCHARGEAI_AWS_PROFILE", "")
os.environ.setdefault("DISCHARGEAI_TIME_BUDGET", "600")
# Up to 6 write/review rounds; the time budget above still stops early if a round would not fit.
os.environ.setdefault("DISCHARGEAI_MAX_ROUNDS", "6")

from bedrock_agentcore.runtime import BedrockAgentCoreApp  # noqa: E402

from dischargeai.config import Settings  # noqa: E402
from dischargeai.frontend import to_discharge_plan  # noqa: E402
from dischargeai.graph import build_graph, recursion_limit  # noqa: E402
from dischargeai.render import render_markdown  # noqa: E402
from patient_agents.translator import FRONTEND_LANGUAGES, translate_discharge_plan  # noqa: E402

settings = Settings.from_env()
graph = build_graph(settings)  # your compiled LangGraph

app = BedrockAgentCoreApp()


def _languages(payload) -> list[str]:
    raw = payload.get("languages", list(FRONTEND_LANGUAGES))
    if not isinstance(raw, list):
        return list(FRONTEND_LANGUAGES)
    return [code for code in dict.fromkeys(raw) if code in FRONTEND_LANGUAGES]


async def _translate(plan_en, code):
    try:
        plan, status, problems = await asyncio.to_thread(translate_discharge_plan, plan_en, code)
        return code, plan, {"status": status, "problems": problems}
    except Exception as e:  # one failed language must not lose the English plan
        return code, None, {"status": "failed", "problems": [f"{type(e).__name__}: {e}"]}


@app.entrypoint
async def invoke(payload, context):
    notes = payload.get("prompt") or payload.get("notes") or ""
    if not isinstance(notes, str) or not notes.strip():
        return {"error": "Send the discharge notes as a string in 'prompt'."}
    notes = notes.strip()
    created_at = int(time.time() * 1000)
    # The graph is synchronous; run it in a thread so the /ping health check keeps answering.
    result = await asyncio.to_thread(
        graph.invoke, {"notes": notes, "rounds": []}, {"recursion_limit": recursion_limit(settings)}
    )
    plan = result["plan"]
    rounds = result.get("rounds", [])
    best = min(rounds, key=lambda r: (len(r["problems"]), -r["number"])) if rounds else None
    review = {
        "rounds": len(rounds),
        # What still failed review in the plan that was returned (empty when approved).
        "problems": best["problems"] if best and result["status"] == "needs_human_review" else [],
    }
    plan_en = to_discharge_plan(plan, salt=hashlib.sha256(notes.encode()).hexdigest()[:16])

    by_lang = {"en": plan_en}
    translations = {}
    for code, translated, info in await asyncio.gather(*(_translate(plan_en, c) for c in _languages(payload))):
        translations[code] = info
        if translated is not None:
            by_lang[code] = translated

    return {
        "result": render_markdown(plan),
        "status": result["status"],
        "flags": result.get("flags", []),
        "review": review,
        "record": {"createdAt": created_at, "byLang": by_lang},
        "translations": translations,
    }


if __name__ == "__main__":
    app.run()
