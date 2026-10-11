# DischargeAI

Patients leave the hospital with discharge instructions written for clinicians. DischargeAI turns a discharge summary (pasted text, a PDF, or dictated audio) into a plain-language Going-Home Plan, sends the patient and their caregiver a private link to it, and deletes everything 30 days later.

- An AI agent on Amazon Bedrock AgentCore writes the plan from the clinician's own instructions and reviews it, flagging anything a clinician should check.
- The patient link is an unguessable 256-bit id; nothing else identifies the patient.
- Every record, file and link expires at day 30, enforced at read time and by automatic deletion, with a deletion receipt that holds no patient data.

## Run it

The server lives in [`backend/`](backend/). With Node 24 and AWS credentials for the DischargeAI account:

```sh
cd backend
npm install
npm run dev
```

Then open `http://localhost:4000/docs`. The full setup, a curl walkthrough from ingest to the patient's plan, the API, and configuration are in [`backend/README.md`](backend/README.md).
