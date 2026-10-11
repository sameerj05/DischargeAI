"""Thin wrappers around the Bedrock Converse API."""

from __future__ import annotations

from typing import Any

import boto3
from botocore.config import Config


class ModelOutputError(RuntimeError):
    """The model returned something we cannot use (truncated, missing tool call, bad shape)."""


def make_client(profile: str | None, region: str):
    session = boto3.Session(profile_name=profile, region_name=region)
    return session.client(
        "bedrock-runtime",
        config=Config(retries={"max_attempts": 5, "mode": "adaptive"}, read_timeout=180),
    )


def converse_text(client, model_id: str, system: str, user_text: str, max_tokens: int) -> str:
    """Single-turn call that returns plain text."""
    response = client.converse(
        modelId=model_id,
        system=[{"text": system}],
        messages=[{"role": "user", "content": [{"text": user_text}]}],
        inferenceConfig={"maxTokens": max_tokens},  # always explicit, see Bedrock quota behavior
    )
    if response["stopReason"] == "max_tokens":
        raise ModelOutputError(f"{model_id} hit maxTokens={max_tokens}; output was truncated")
    text = "".join(block.get("text", "") for block in response["output"]["message"]["content"])
    if not text.strip():
        raise ModelOutputError(f"{model_id} returned an empty response")
    return text.strip()


def converse_structured(
    client,
    model_id: str,
    system: str,
    user_text: str,
    tool_name: str,
    tool_description: str,
    schema: dict[str, Any],
    max_tokens: int,
) -> dict[str, Any]:
    """Single-turn call that forces the model to answer through one tool, giving us JSON.

    Tool use is the structured-output approach that works across Claude generations.
    The returned dict is still untrusted model output; callers must validate it.
    """
    response = client.converse(
        modelId=model_id,
        system=[{"text": system}],
        messages=[{"role": "user", "content": [{"text": user_text}]}],
        inferenceConfig={"maxTokens": max_tokens},
        toolConfig={
            "tools": [
                {
                    "toolSpec": {
                        "name": tool_name,
                        "description": tool_description,
                        "inputSchema": {"json": schema},
                    }
                }
            ],
            "toolChoice": {"tool": {"name": tool_name}},
        },
    )
    if response["stopReason"] == "max_tokens":
        raise ModelOutputError(f"{model_id} hit maxTokens={max_tokens}; structured output was truncated")
    for block in response["output"]["message"]["content"]:
        tool_use = block.get("toolUse")
        if tool_use and tool_use.get("name") == tool_name and isinstance(tool_use.get("input"), dict):
            return tool_use["input"]
    raise ModelOutputError(f"{model_id} did not call the {tool_name} tool")
