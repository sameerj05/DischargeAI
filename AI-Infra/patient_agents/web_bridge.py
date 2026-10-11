"""JSON stdin/stdout bridge for the existing checked translation agent.

No shell commands or file paths come from the request. Only translated display
strings change; identifiers and dose tracking remain owned by the source plan.
"""
from __future__ import annotations

import json
import sys
from .translator import translate_discharge_plan


def main() -> int:
    request = json.load(sys.stdin)
    if not isinstance(request, dict) or not isinstance(request.get("plan"), dict):
        raise ValueError("A frontend plan is required")
    plan, status, problems = translate_discharge_plan(request["plan"], request.get("lang"), log=lambda *_: None)
    json.dump({"plan": plan, "status": status, "problems": problems}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    sys.exit(main())
