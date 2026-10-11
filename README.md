# DischargeAI
Rutgers Health Hack 2026

Turns doctor/nurse discharge notes, including messy speech-to-text transcripts, into a 5th grade "Going-Home Plan" checklist. Built with LangGraph, using Claude Sonnet 4.6 on Amazon Bedrock.

```
notes -+-> build_context ------+
       |                       +-> write_summary -> review --pass--> finalize (approved / needs_clinician_check)
       +-> comprehend_medical -+                      |
                                                      +--fail--> choose_fix --> patch_summary    --+
                                                      |          (code)     --> rewrite_sections --+--> review
                                                      |                     --> write_summary   --+
                                                      +--out of rounds--> human_review
```

After a failed review, `choose_fix` (plain code) decides how much to redo. Every plan line has an id, and every problem is tied to the lines it is about:
- patch: under 25% of lines flagged and at most 5 missing facts. The writer returns edits (replace / delete / move / add) for only the flagged lines plus lines for the same medicine. Code rejects edits to any other line.
- section: 4+ flagged lines and 60%+ of them in one section group (medicines, warnings, to-do, ...). Only that group is rewritten.
- full: more than that, or a plan-wide problem.
It escalates patch -> section -> full when a round does not reduce the problems, and rolls back to the best draft so far when a round makes things worse.

Sensitive topics: illegal drug use and sexual history never appear in the plan. All three agents are told to leave them out, the reviewer cannot demand them as "missing", a code check fails any line that mentions them, and the final plan is scrubbed as a last guard (`dischargeai/sensitive.py`). Prescribed medicines are still listed (a fentanyl patch, buprenorphine), without a drug-use reason, and post-procedure activity instructions are allowed.

- comprehend_medical: sends the raw notes to Amazon Comprehend Medical (DetectEntitiesV2 + InferRxNorm). Returns medicines with dose/frequency/route and RxNorm codes, conditions with traits like NEGATION, tests, and time expressions. Runs in parallel with build_context. The writer gets this output next to the raw notes and uses it as a second checklist; the raw notes stay the source of truth.
- build_context (context agent): combines all input notes into one structured patient record. Handles transcripts: self-corrections, spoken numbers, scattered facts, and garbled medicine names (marked uncertain, never guessed).
- write_summary (writer agent): fills in the plan as structured JSON. `render.py` turns it into the checklist: medicines by time of day, new/stopped medicines, tests, appointments, care steps, questions for the care team, and warning signs.
- review (reviewer agent + code checks): checks the plan against the original notes for missing, wrong, or made-up information. A claim only counts if the reviewer quotes it from the plan. Code also checks the reading level (Flesch-Kincaid 6.0 or lower), exact medicine names, and duplicate doses in the checklist.
- finalize: a plan that passes but contains an unclear medicine name is marked `needs_clinician_check`, not `approved`.

## Run

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m dischargeai samples\jane_doe
.\.venv\Scripts\python.exe -m dischargeai samples\transcripts\heart_failure --trace output\heart_failure.json
```

Input is any mix of `.txt` files and folders of `.txt` files. All of them are combined as one patient. Every step prints to the terminal. `--trace` also saves the full run as JSON, including the plan JSON. `--show-graph` prints the graph as a Mermaid diagram.

Samples:
- `samples/jane_doe`: typed physician note + nursing note
- `samples/transcripts/heart_failure`: physician voice memo + 3-person bedside conversation
- `samples/transcripts/peds_asthma`: nurse/parent conversation with a dose correction
- `samples/transcripts/knee_replacement`: surgeon memo with speech-to-text errors ("a liquids", "oxy codone")

Test cases: `samples/test_cases.json` holds inline input cases (one structured, one natural language). This runs them all in parallel and writes inputs + outputs side by side to `output/test_results.json`:

```powershell
.\.venv\Scripts\python.exe -m dischargeai.run_cases
.\.venv\Scripts\python.exe -m dischargeai.run_cases --only natural_language_gi_bleed --out output\gi.json
```

Exit codes: 0 approved, 3 needs clinician check, 2 needs human review. Settings come from env vars: `DISCHARGEAI_AWS_PROFILE` (default `healthhack`), `DISCHARGEAI_AWS_REGION` (`us-west-2`), `DISCHARGEAI_CONTEXT_MODEL`, `DISCHARGEAI_WRITER_MODEL`, `DISCHARGEAI_REVIEWER_MODEL`, `DISCHARGEAI_MAX_ROUNDS` (`4`), `DISCHARGEAI_MAX_GRADE` (`6.0`).

## Standalone patient agents (`patient_agents/`)

Two agents that are NOT part of the pipeline above. Each takes a finished Going-Home Plan (`.md`) as input.

Translator: translates the plan into any language, line by line, so the checklist layout cannot break. Code checks every line kept its numbers, doses, dates, bold markers, and medicine names; a second model call checks meaning. Flagged lines are re-translated up to 2 times, and the result is marked `verified` or `needs_review`.

```powershell
.\.venv\Scripts\python.exe -m patient_agents.translator output\stroke\stroke_left_mca.md --to Spanish
```

Chatbot: answers patient questions from the plan only.
- Emergency or crisis words (chest pain, can't breathe, hurt myself) get an instant "call 911" or "call or text 988", with no model call.
- "Should I take X?" is decided by code from the plan's medicine lists: on the take list = yes (quoting the plan line); stopped, or an old dose = no; not in the plan = no, and call your nurse or doctor. Requests to change a dose are always "take it only as your plan says".
- Other questions are answered only when the model is confident, quotes plan lines that really exist, and adds no numbers or medicines the plan doesn't support.
- Medical advice, diagnosis questions, sensitive topics, and anything uncertain get "please call your nurse or doctor".
- Replies in English or Spanish.

```powershell
.\.venv\Scripts\python.exe -m patient_agents.chatbot output\stroke\stroke_left_mca.md
.\.venv\Scripts\python.exe -m patient_agents.chatbot output\stroke\stroke_left_mca.md --ask "Should I take aspirin?" --debug
```

Models: `PATIENT_CHAT_MODEL`, `PATIENT_TRANSLATE_MODEL` (default Claude Sonnet 4.6). AWS settings are shared with the pipeline.

## Comprehend Medical

`DISCHARGEAI_COMPREHEND` controls it: `auto` (default) uses it when allowed and otherwise continues on the raw notes, `on` stops the run if it is unavailable, `off` skips it. `DISCHARGEAI_COMPREHEND_REGION` defaults to the AWS region.

If the role lacks Comprehend Medical permissions, runs show "Not used: AccessDeniedException". The role needs this policy (Comprehend Medical actions don't support resource-level permissions, so `Resource` must be `*`):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["comprehendmedical:DetectEntitiesV2", "comprehendmedical:InferRxNorm"],
    "Resource": "*"
  }]
}
```

## Extending

Add a node function in `dischargeai/graph.py`, register it in `build_graph()`, and wire its edges. Nodes share `DischargeState`. From code: `from dischargeai import generate_discharge_summary, build_graph`.

Use synthetic data only. The workshop account is not set up for real patient information.
