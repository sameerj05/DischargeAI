"""Amazon Comprehend Medical: machine-extracted medical entities from the raw notes.

Calls DetectEntitiesV2 (medicines, conditions, tests, with dose/frequency attributes and
traits like NEGATION) and InferRxNorm (normalized RxNorm medicine concepts), then condenses
the result into a compact JSON the writer agent reads alongside the raw notes.
"""

from __future__ import annotations

from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

# Service limits: DetectEntitiesV2 20 KB, InferRxNorm 10 KB per request. One chunk size that
# fits both keeps the offsets simple.
CHUNK_BYTES = 9000

# Errors that mean "this account cannot use Comprehend Medical", not "something broke".
UNAVAILABLE_CODES = {"AccessDeniedException", "UnrecognizedClientException", "SubscriptionRequiredException"}

KEEP_CATEGORIES = {
    "MEDICATION": "medications",
    "MEDICAL_CONDITION": "conditions",
    "TEST_TREATMENT_PROCEDURE": "tests_treatments",
    "BEHAVIORAL_ENVIRONMENTAL_SOCIAL": "social",
    "TIME_EXPRESSION": "time_expressions",
}
# PROTECTED_HEALTH_INFORMATION and ANATOMY entities are not passed on.


class ComprehendUnavailable(RuntimeError):
    """Comprehend Medical cannot be used with these credentials or in this region."""


def make_client(profile: str | None, region: str):
    session = boto3.Session(profile_name=profile, region_name=region)
    return session.client("comprehendmedical", config=Config(retries={"max_attempts": 5, "mode": "adaptive"}))


def chunk_text(text: str, max_bytes: int = CHUNK_BYTES) -> list[tuple[int, str]]:
    """Split text on line boundaries into (char_offset, chunk) pieces under max_bytes."""
    chunks: list[tuple[int, str]] = []
    start, current, current_bytes = 0, "", 0
    pos = 0
    for line in text.splitlines(keepends=True):
        line_bytes = len(line.encode("utf-8"))
        if current and current_bytes + line_bytes > max_bytes:
            chunks.append((start, current))
            start, current, current_bytes = pos, "", 0
        # A single line longer than the limit is hard-split by characters.
        while line_bytes > max_bytes:
            cut = max_bytes // 4  # safe for 4-byte UTF-8 characters
            chunks.append((pos, line[:cut]))
            pos += cut
            line = line[cut:]
            line_bytes = len(line.encode("utf-8"))
            start = pos
        current += line
        current_bytes += line_bytes
        pos += len(line)
    if current.strip():
        chunks.append((start, current))
    return [(off, c) for off, c in chunks if c.strip()]


def _call(client, operation: str, text: str) -> dict[str, Any]:
    try:
        return getattr(client, operation)(Text=text)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in UNAVAILABLE_CODES:
            raise ComprehendUnavailable(f"{code}: {e.response.get('Error', {}).get('Message', '')}") from e
        raise
    except BotoCoreError as e:  # e.g. no endpoint for this region
        raise ComprehendUnavailable(str(e)) from e


def _attributes(entity: dict[str, Any]) -> dict[str, str]:
    attrs: dict[str, list[str]] = {}
    for a in entity.get("Attributes", []):
        if a.get("Text"):
            attrs.setdefault(a["Type"], []).append(a["Text"])
    return {k: "; ".join(v) for k, v in attrs.items()}


def _traits(entity: dict[str, Any], min_score: float = 0.5) -> list[str]:
    return sorted({t["Name"] for t in entity.get("Traits", []) if t.get("Score", 0) >= min_score})


def condense(entities: list[dict[str, Any]], rx_entities: list[dict[str, Any]]) -> dict[str, Any]:
    """Turn raw API entities (offsets already absolute) into the writer-facing summary."""
    rx_by_span = {(e["BeginOffset"], e["EndOffset"]): e for e in rx_entities}
    rx_by_text = {e["Text"].lower(): e for e in rx_entities}

    out: dict[str, list[dict[str, Any]]] = {key: [] for key in KEEP_CATEGORIES.values()}
    for e in sorted(entities, key=lambda x: x["BeginOffset"]):
        key = KEEP_CATEGORIES.get(e.get("Category", ""))
        if not key:
            continue
        item: dict[str, Any] = {"text": e["Text"], "type": e.get("Type", ""), "score": round(e.get("Score", 0), 2)}
        if key == "time_expressions":
            out[key].append(item)
            continue
        if attrs := _attributes(e):
            item["attributes"] = attrs
        if traits := _traits(e):
            item["traits"] = traits
        if key == "medications":
            rx = rx_by_span.get((e["BeginOffset"], e["EndOffset"])) or rx_by_text.get(e["Text"].lower())
            concepts = (rx or {}).get("RxNormConcepts") or []
            if concepts:
                top = max(concepts, key=lambda c: c.get("Score", 0))
                item["rxnorm"] = {"code": top["Code"], "description": top["Description"],
                                  "score": round(top.get("Score", 0), 2)}
        out[key].append(item)
    return out


def analyze(client, notes: str) -> dict[str, Any]:
    """Run Comprehend Medical over the notes. Raises ComprehendUnavailable if access is denied."""
    entities: list[dict[str, Any]] = []
    rx_entities: list[dict[str, Any]] = []
    model_version = ""
    chunks = chunk_text(notes)
    for offset, chunk in chunks:
        det = _call(client, "detect_entities_v2", chunk)
        rx = _call(client, "infer_rx_norm", chunk)
        model_version = det.get("ModelVersion", model_version)
        for source, target in ((det, entities), (rx, rx_entities)):
            for e in source.get("Entities", []):
                target.append({**e, "BeginOffset": e["BeginOffset"] + offset, "EndOffset": e["EndOffset"] + offset})
    return {
        "status": "ok",
        "model_version": model_version,
        "chunks": len(chunks),
        "characters": len(notes),
        **condense(entities, rx_entities),
    }


def unavailable(reason: str) -> dict[str, Any]:
    return {"status": "unavailable", "reason": reason}


def disabled() -> dict[str, Any]:
    return {"status": "disabled", "reason": "Turned off with DISCHARGEAI_COMPREHEND=off"}
