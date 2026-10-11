"""Standalone patient-facing agents. They are NOT part of the DischargeAI LangGraph pipeline.

Both take a finished Going-Home Plan (the Markdown the pipeline writes) as input:
- translator: translates the plan into a language of choice, with code checks that numbers,
  doses, dates, and medicine names survive the translation.
- chatbot:    answers patient questions using only the plan, and sends the patient to their
  nurse or doctor whenever the plan does not clearly answer the question.

Run them with:
    python -m patient_agents.translator output\\stroke\\stroke_left_mca.md --to Spanish
    python -m patient_agents.chatbot output\\stroke\\stroke_left_mca.md
"""
