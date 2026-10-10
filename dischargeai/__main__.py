"""CLI.

    python -m dischargeai samples\\jane_doe                 # every .txt file in a folder
    python -m dischargeai doctor.txt nurse.txt            # or specific files
    python -m dischargeai samples\\jane_doe --trace output\\trace.json
    python -m dischargeai --show-graph                    # print the graph as Mermaid
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from botocore.exceptions import BotoCoreError, ClientError

from . import display
from .bedrock import ModelOutputError
from .comprehend import ComprehendUnavailable
from .config import Settings
from .graph import build_graph, recursion_limit


def compile_notes(paths: list[Path]) -> tuple[str, list[str]]:
    """Combine every input file into one labeled block of clinician notes."""
    files: list[Path] = []
    for p in paths:
        if p.is_dir():
            files.extend(sorted(p.glob("*.txt")))
        elif p.is_file():
            files.append(p)
        else:
            raise FileNotFoundError(f"No such file or folder: {p}")
    if not files:
        raise ValueError("No .txt files found in the given input")
    return format_sources([(f.name, f.read_text(encoding="utf-8")) for f in files]), [f.name for f in files]


def format_sources(sources: list[tuple[str, str]]) -> str:
    """Label each (name, text) source and join them into one block of clinician notes."""
    return "\n\n".join(f"--- SOURCE: {name} ---\n{text.strip()}" for name, text in sources)


def main() -> int:
    # Windows consoles default to a legacy code page; avoid crashes on characters like "°".
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Turn clinician notes into a 5th grade discharge summary.")
    parser.add_argument("inputs", nargs="*", type=Path, help="Note files and/or folders of .txt notes")
    parser.add_argument("--trace", type=Path, help="Also save the full run as JSON to this path")
    parser.add_argument("--show-graph", action="store_true", help="Print the agent graph (Mermaid) and exit")
    args = parser.parse_args()

    settings = Settings.from_env()

    if args.show_graph:
        print(build_graph(settings, client=object(), cm_client=object()).get_graph().draw_mermaid())
        return 0
    if not args.inputs:
        parser.error("give at least one notes file or folder")

    try:
        notes, sources = compile_notes(args.inputs)
        display.show_input(notes, sources)

        app = build_graph(settings)
        state: dict = {"notes": notes, "rounds": []}
        # stream_mode="updates" yields {node_name: changes} as each node finishes.
        for event in app.stream(state, config={"recursion_limit": recursion_limit(settings)},
                                stream_mode="updates"):
            for node, update in event.items():
                for key, value in update.items():
                    state[key] = state.get(key, []) + value if key == "rounds" else value
                if node == "build_context":
                    display.show_context(update["patient_context"])
                elif node == "comprehend_medical":
                    display.show_comprehend(update["medical_entities"])
                elif node in ("write_summary", "patch_summary", "rewrite_sections"):
                    display.show_draft(update["round"], update["review_view"])
                    display.show_edits(update.get("last_edits") or {})
                elif node == "choose_fix":
                    display.show_fix(update)
                elif node == "review":
                    display.show_review(update["rounds"][-1], settings.max_grade_level)
        display.show_final(state)
    except (OSError, ValueError, ModelOutputError) as e:
        print(f"Error: {e}")
        return 1
    except ComprehendUnavailable as e:
        print(f"Comprehend Medical is required (DISCHARGEAI_COMPREHEND=on) but unavailable: {e}")
        return 1
    except (ClientError, BotoCoreError) as e:
        print(f"AWS error: {e}")
        return 1

    if args.trace:
        args.trace.parent.mkdir(parents=True, exist_ok=True)
        args.trace.write_text(json.dumps(state, indent=2), encoding="utf-8")
        print(f"Full trace saved to {args.trace}")
    return {"approved": 0, "needs_clinician_check": 3}.get(state.get("status", ""), 2)


if __name__ == "__main__":
    sys.exit(main())
