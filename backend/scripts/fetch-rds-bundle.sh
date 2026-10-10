#!/bin/sh
# AWS RDS "connection steps", step 1, as the console prints it for the `patients` instance:
#   curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
# The bundle is the public RDS certificate-authority set the backend passes to mysql2 as `ssl.ca`
# (env RDS_CA_BUNDLE, default backend/certs/global-bundle.pem, which is committed; this script
# refreshes it). Step 2 (the mysql client command) is in README.md under "Team infrastructure".
#   sh scripts/fetch-rds-bundle.sh                 # writes backend/certs/global-bundle.pem
#   sh scripts/fetch-rds-bundle.sh /some/path.pem  # writes elsewhere
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$DIR/certs/global-bundle.pem}"
mkdir -p "$(dirname "$OUT")"
curl -fsS -o "$OUT" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
