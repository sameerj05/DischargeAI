#!/bin/sh
# AWS RDS "connection steps", step 1, verbatim from the console for the `patients` instance:
#   curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
# Downloads the public RDS certificate bundle into backend/certs/ (the path RDS_CA_BUNDLE points at).
# The bundle is public and a copy is committed; run this to refresh it.
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$DIR"
cd "$DIR"
curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
echo "wrote $DIR/global-bundle.pem ($(grep -c 'BEGIN CERTIFICATE' global-bundle.pem) certificates)"
