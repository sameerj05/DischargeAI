#!/bin/sh
# Runs DynamoDB Local without Docker (Java 17+ required). Downloads the jar from AWS on first use.
#   sh scripts/dynamodb-local.sh            # in-memory on :8000
#   DYNAMO_ENDPOINT=http://localhost:8000 npm run setup-dynamo
#   DOC_STORE=dynamo DYNAMO_ENDPOINT=http://localhost:8000 npm run dev
# Docker users: `docker compose up` does the same with amazon/dynamodb-local (see docker-compose.yml).
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)/.dynamodb-local"
PORT="${DDB_PORT:-8000}"
URL="https://s3.us-west-2.amazonaws.com/dynamodb-local/dynamodb_local_latest.tar.gz"
mkdir -p "$DIR"
if [ ! -f "$DIR/DynamoDBLocal.jar" ]; then
  echo "downloading DynamoDB Local to $DIR"
  curl -fsSL "$URL" -o "$DIR/ddb.tar.gz"
  tar -xzf "$DIR/ddb.tar.gz" -C "$DIR"
  rm -f "$DIR/ddb.tar.gz"
fi
cd "$DIR"
echo "DynamoDB Local on http://localhost:$PORT (in-memory; Ctrl-C to stop)"
exec java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port "$PORT"
