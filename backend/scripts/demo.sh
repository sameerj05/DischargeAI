#!/bin/sh
# DischargeAI demo narrative against a running backend (default: offline providers, SQLite, no keys).
#   npm run dev            (in another terminal)
#   npm run demo           (this script)
# Steps: health -> pick a patient -> ingest Example 1 (CHF) with Spanish, Mandarin and Arabic picked
#        -> the server prints the patient email -> GET /summary -> GET /p/:token (the diagram's contract)
#        -> the three picked languages come straight from the store, Portuguese is translated on demand
#        and cached -> checklist tick -> POST /synthesize dry run -> day 30 arrives -> 410 -> purge
#        -> deletion receipts in the audit trail.
# Needs curl and node (for JSON parsing). Override BASE_URL / PROVIDER_API_KEY / PATIENT_ID / INPUT / LANGS as needed.
# Everything is written to stdout, so `npm run demo > demo.log 2>&1` and `| tee demo.log` both keep the whole run.
# For a rehearsal where only the explicit purge in step 11 should run, start the server with PURGE_INTERVAL_MS=0.
set -eu

BASE_URL="${BASE_URL:-http://localhost:${PORT:-4000}}"
KEY="${PROVIDER_API_KEY:-dev-provider-key}"
INPUT="${INPUT:-fixtures/discharge-summaries/example-1-chf.txt}"
LANGS="${LANGS:-es,zh,ar}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "1. Health: which SQL, document store, audio store and config source are live"
HEALTH=$(curl -sS "$BASE_URL/health")
echo "config:    $(printf '%s' "$HEALTH" | json config)"
echo "sql:       $(printf '%s' "$HEALTH" | json sql)"
echo "audio:     $(printf '%s' "$HEALTH" | json audio)"
echo "providers: $(printf '%s' "$HEALTH" | json providers)"

step "2. Pick a patient (GET /patients)"
PATIENTS=$(curl -sS -H "x-provider-key: $KEY" "$BASE_URL/patients")
PATIENT_ID="${PATIENT_ID:-$(printf '%s' "$PATIENTS" | json patients.0.id)}"
printf '%s' "$PATIENTS" | json patients.0
echo "patientId=$PATIENT_ID"

step "3. Ingest Example 1, the CHF discharge summary, with languages=$LANGS picked (POST /ingest -> 202)"
if [ "${INPUT##*.}" = "pdf" ]; then
  ACCEPTED=$(curl -sS -H "x-provider-key: $KEY" -F "patientId=$PATIENT_ID" -F "languages=$LANGS" -F "file=@$INPUT;type=application/pdf" "$BASE_URL/ingest")
else
  ACCEPTED=$(curl -sS -H "x-provider-key: $KEY" -F "patientId=$PATIENT_ID" -F "languages=$LANGS" -F "text=<$INPUT" "$BASE_URL/ingest")
fi
echo "$ACCEPTED"
JOB_ID=$(printf '%s' "$ACCEPTED" | json jobId)
LINK_ID=$(printf '%s' "$ACCEPTED" | json linkId)
[ -n "$JOB_ID" ] && [ "$JOB_ID" != "undefined" ] || { echo "ingest failed"; exit 1; }

step "4. Poll the job (GET /jobs/:id) until done; the server prints the patient email"
for i in $(seq 1 120); do
  JOB=$(curl -sS -H "x-provider-key: $KEY" "$BASE_URL/jobs/$JOB_ID")
  STAGE=$(printf '%s' "$JOB" | json stage)
  echo "  stage=$STAGE"
  case "$STAGE" in done|needs_review|failed) break ;; esac
  sleep 1
done
echo "languages produced at synthesis: $(printf '%s' "$JOB" | json meta.languages)   fidelity: $(printf '%s' "$JOB" | json meta.fidelity)   stages: $(printf '%s' "$JOB" | json meta.stages)"
[ "$STAGE" != "failed" ] || { echo "job failed"; exit 1; }

step "5. The patient opens the link (GET /summary?link=...): the richer shape"
SUMMARY=$(curl -sS "$BASE_URL/summary?link=$LINK_ID")
echo "$SUMMARY" | json summary
echo "new medications:"; echo "$SUMMARY" | json medications.new
echo "daysLeft: $(echo "$SUMMARY" | json daysLeft)   readyLanguages: $(echo "$SUMMARY" | json readyLanguages)"
echo "verification: $(echo "$SUMMARY" | json verification)"

step "6. The same record as the team diagram's contract (GET /p/:token): steps, medications, followUps, warnings + meta"
VIEW=$(curl -sS "$BASE_URL/p/$LINK_ID")
echo "medications[0]: $(echo "$VIEW" | json medications.0)"
echo "warnings[0]:    $(echo "$VIEW" | json warnings.0)"
echo "steps:          $(echo "$VIEW" | json steps | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length+" items"))')"
echo "meta.languages: $(echo "$VIEW" | json meta.languages)"
echo "meta.safety:    $(echo "$VIEW" | json meta.safetyChecks)"

step "7. One tap per language: the picked ones are already stored (fromCache true); Portuguese is translated now, then cached"
for L in Spanish zh ar; do
  TR=$(curl -sS "$BASE_URL/translate?link=$LINK_ID&language=$L")
  echo "[$L] fromCache=$(echo "$TR" | json fromCache) backTranslation=$(echo "$TR" | json verification.backTranslationCheck) :: $(echo "$TR" | json summary | cut -c1-110)"
done
PT1=$(curl -sS "$BASE_URL/p/$LINK_ID?language=pt")
PT2=$(curl -sS "$BASE_URL/p/$LINK_ID?language=pt")
echo "[pt] first call fromCache=$(echo "$PT1" | json meta.fromCache), second call fromCache=$(echo "$PT2" | json meta.fromCache)"
echo "GET /languages: $(curl -sS "$BASE_URL/languages" | json languages | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(l=>l.code).join(" ")))')"

step "8. The patient ticks a checklist item (POST /checklist/complete)"
FIRST_ITEM=$(echo "$SUMMARY" | json checklist.0.id)
curl -sS -H 'content-type: application/json' -d "{\"link\":\"$LINK_ID\",\"itemId\":\"$FIRST_ITEM\",\"completed\":true}" "$BASE_URL/checklist/complete"; echo

step "9. Person C's endpoint: POST /synthesize { text, languages } runs the pipeline and returns the JSON per language (nothing stored)"
SYN=$(curl -sS -H "x-provider-key: $KEY" -H 'content-type: application/json' --data-binary "$(node -e 'const fs=require("fs");console.log(JSON.stringify({text:fs.readFileSync(process.argv[1],"utf8"),languages:["es"]}))' "$INPUT")" "$BASE_URL/synthesize")
echo "perLanguage keys: $(echo "$SYN" | json perLanguage | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).join(" ")))')   stored: $(echo "$SYN" | json stored)   fidelity: $(echo "$SYN" | json meta.safetyChecks.fidelity)"

# Patient reads after day 30. The body goes to stdout with the status on its own line (never -o
# /dev/stderr: reopening it truncates a log the demo is being captured into). The read-time check
# answers 410 link_expired on its own; if the interval purge job (PURGE_INTERVAL_MS, 60 s by default)
# happened to fire first the body says link_purged instead. Both prove day 30 is enforced.
read_410() { curl -sS -w '\nHTTP %{http_code}\n' "$1"; }
receipts() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s)||[];console.log("  "+a.length+" receipt(s)");for(const r of a)console.log("  receipt",String(r.event).padEnd(16),r.what??(r.details&&(r.details.doc?r.details.table+"/"+r.details.doc:r.details.key?r.details.store+":"+r.details.key:"data key v"+r.details.keyVersion)))})'; }

step "10. Day 30 arrives (POST /admin/clock/advance 30 days) -> GET /summary and GET /p/:token answer 410 (expired, or already purged if the interval job got there first)"
curl -sS -H "x-provider-key: $KEY" -H 'content-type: application/json' -d '{"days":30}' "$BASE_URL/admin/clock/advance"; echo
read_410 "$BASE_URL/summary?link=$LINK_ID"
read_410 "$BASE_URL/p/$LINK_ID"

step "11. Purge runs now (POST /admin/purge): key destroyed, every document deleted, link purged, one receipt each"
PURGE=$(curl -sS -H "x-provider-key: $KEY" -X POST "$BASE_URL/admin/purge")
echo "this run: linksPurged=$(echo "$PURGE" | json linksPurged) keysDestroyed=$(echo "$PURGE" | json keysDestroyed) documentsDeleted=$(echo "$PURGE" | json documentsDeleted) audioDeleted=$(echo "$PURGE" | json audioDeleted)"
echo "this link's deletion receipts in the audit log (GET /audit?link=), whichever purge run wrote them:"
curl -sS -H "x-provider-key: $KEY" "$BASE_URL/audit?link=$LINK_ID" | json deletionReceipts | receipts
echo "the link after the purge:"
read_410 "$BASE_URL/summary?link=$LINK_ID"

step "12. Audit trail (GET /audit?link=...): events and the deletion receipts, no PHI"
AUDIT=$(curl -sS -H "x-provider-key: $KEY" "$BASE_URL/audit?link=$LINK_ID")
echo "$AUDIT" | json events | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s))console.log(" ",e.at,e.actor.padEnd(8),e.event.padEnd(20),JSON.stringify(e.details).slice(0,120))})'
echo "deletionReceipts: $(echo "$AUDIT" | json deletionReceipts | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')   link: $(echo "$AUDIT" | json link)"
echo "all receipts ever (GET /audit/receipts): $(curl -sS -H "x-provider-key: $KEY" "$BASE_URL/audit/receipts" | json count)"

step "13. Reset the demo clock"
curl -sS -H "x-provider-key: $KEY" -X POST "$BASE_URL/admin/clock/reset"; echo
echo "demo complete"
