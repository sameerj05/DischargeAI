import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeText, isEmptyText } from "../src/extract/text.js";
import { decodePdfData, looksLikePdf } from "../src/extract/pdfToText.js";
import { mapColumns } from "../src/db/repos/patients.js";
import { isSumIdShaped, logRef, newSumId } from "../src/crypto/sumId.js";
import { adaptSummary } from "../../frontend/src/planAdapter.js";
import { adaptMarkdownPlan } from "../../frontend/src/markdownPlan.js";

test("PDF wrappers and text cleanup preserve medication dose and timing", () => {
  const source = "Page 1 of 2\r\nFurosemide 40 mg once daily.  \r\n\r\n\r\n-- 2 of 2 --\r\nDo not take lisinopril.\u00a0";
  assert.equal(normalizeText(source), "Furosemide 40 mg once daily.\n\nDo not take lisinopril.");
  assert.equal(isEmptyText("\r\nPage 1 of 1\n"), true);
  const bytes = Buffer.from("%PDF-1.4\nSynthetic bytes");
  for (const data of [bytes.toString("base64"), "data:application/pdf;base64," + bytes.toString("base64"), bytes.toString("base64url")]) {
    assert.deepEqual(decodePdfData(data), bytes); assert.equal(looksLikePdf(decodePdfData(data)), true);
  }
  assert.equal(decodePdfData("not!base64").length, 0); assert.equal(looksLikePdf(Buffer.from("plain text")), false);
});

test("RDS column aliases prioritize patient ID and recognize DOB and contact variants", () => {
  const columns = mapColumns(["uid", "ID", "first_name", "last_name", "birth_date", "email_address", "caregiver_email", "mobile_number"]);
  assert.equal(columns.id, "ID"); assert.equal(columns.dateOfBirth, "birth_date"); assert.equal(columns.caregiverEmail, "caregiver_email");
  assert.equal(columns.phone, "mobile_number"); assert.equal(mapColumns(["unrelated"]).id, undefined);
});

test("patient tokens contain no patient identifiers and log references conceal the token", () => {
  const tokens = Array.from({ length: 100 }, newSumId);
  assert.equal(new Set(tokens).size, tokens.length); assert.ok(tokens.every(isSumIdShaped));
  for (const bad of [null, 7, "", "A".repeat(42), "A".repeat(44), "/".repeat(43)]) assert.equal(isSumIdShaped(bad), false);
  assert.match(logRef(tokens[0]), /^[a-f0-9]{8}$/); assert.equal(logRef(tokens[0]), logRef(tokens[0])); assert.notEqual(logRef(tokens[0]), tokens[0]);
});

test("the actual frontend adapter preserves frequencies, review flags, source privacy and legacy result text", () => {
  const envelope = { sumId: newSumId(), patientID: "7", status: "ready", createdAt: "2026-10-11T12:00:00Z", expiresAt: "2026-11-10T12:00:00Z", daysLeft: 30 };
  const value = adaptSummary({ ...envelope, "llm-summary": { status: "needs_clinician_check", flags: ["Review needed"], summary: "Summary",
    plan: { why_in_hospital: [{ text: "Observation", proof: ["private clinician quote"] }], schedule: { twice_daily: [{ medicine: "Sample medication", purpose: "Example", note: "As instructed" }] },
      appointments: [], care_instructions: [], tests: [] } } });
  const group = value.record.byLang.en!.medications.groups[0];
  assert.equal(group.key, "twiceDaily"); assert.equal(group.label, "2 TIMES A DAY"); assert.equal(group.items.length, 2);
  assert.ok(group.items.every(item => !/morning|evening/i.test(item.reason)));
  assert.equal(JSON.stringify(value).includes("private clinician quote"), false);
  assert.deepEqual(value.flags, ["Review needed"]); assert.equal(value.record.byLang.es, undefined);
  const legacy = adaptSummary({ ...envelope, "llm-summary": { result: "Legacy plan text", status: "approved", flags: [] } });
  assert.equal(legacy.summary, "Legacy plan text"); assert.equal(legacy.record.byLang.en, undefined);
});

test("AgentCore Markdown populates the existing cards while preserving medication and follow-up details", () => {
  const markdown = `# Your Going-Home Plan
## Why you were in the hospital
- Heart failure.
## Your medication list
These are all the medicines you should take now.
### ONCE A DAY
- [ ] Furosemide 40 mg – NEW
### 2 TIMES A DAY
- [ ] [ ] Example 5 mg – with food
### New medicines
- **Furosemide 40 mg, once daily** – Removes extra fluid.
### Stopped medicines
- **Lisinopril** – STOPPED. Stop taking this medicine.
## Things for you to do
### Labs and tests
- [ ] Basic metabolic panel – Before cardiology.
### Appointments
- [ ] Cardiology – Within one week – Clinic A.
If you do not have a date for a visit yet, call the office to set one up.
## Instructions for your care
- [ ] Weigh yourself each morning.
## Questions to ask your care team
- [ ] Ask when to restart the held medicine.
## Call your doctor if
- Dizziness.
## Get help RIGHT AWAY for:
- Chest pain.
If it feels like an emergency, call 911.`;
  const adapted = adaptSummary({ sumId: newSumId(), patientID: "7", status: "ready", createdAt: "2026-10-11T12:00:00Z",
    daysLeft: 30, "llm-summary": { result: markdown, status: "approved", flags: [] } });
  const plan = adapted.record.byLang.en!;
  assert.equal(adapted.summary, markdown);
  assert.deepEqual(plan.medications.groups.map(group => [group.key, group.items.length]), [["onceDaily", 1], ["twiceDaily", 2]]);
  assert.equal(plan.medications.groups[0].items[0].name, "Furosemide 40 mg");
  assert.equal(plan.stoppedMedicines[0].detail, "STOPPED. Stop taking this medicine.");
  assert.equal(plan.todos.labs[0].label, "Basic metabolic panel – Before cardiology.");
  assert.equal(plan.todos.appointments[0].label, "Cardiology – Within one week – Clinic A.");
  assert.deepEqual(plan.warningSigns.signs, ["Chest pain."]);
  assert.ok(!JSON.stringify(plan).match(/morning.*Example|evening.*Example/));
  assert.equal(adaptMarkdownPlan(markdown + "\n## Unexpected instructions\n- Preserve this."), undefined);
  assert.equal(adaptMarkdownPlan(markdown.replace("- Heart failure.", "Keep this unmatched paragraph.")), undefined);
  const noEmergency = adaptMarkdownPlan(markdown.replace("If it feels like an emergency, call 911.", ""))!;
  assert.equal(noEmergency.warningSigns.emergencyLine, "");
});
