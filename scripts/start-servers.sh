#!/usr/bin/env bash
# Pulls the latest code, then (re)starts the backend (:3000) and frontend (:80) in the background.
# Backend DB settings come from backend/.env (DB_HOST, DB_USER, DB_PASSWORD) or the current environment.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${HOME}/.dischargeai"
BACKEND_PORT=3000
FRONTEND_PORT=80

stop_server() {
  local name="$1" pidfile="$RUN_DIR/$1.pid"
  [[ -f "$pidfile" ]] || return 0
  local pid
  pid="$(cat "$pidfile")"
  # Each server runs in its own session, so -PID also stops npm's node child.
  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping previous $name (pid $pid)"
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$pidfile"
}

start_server() {
  local name="$1"
  local log="$RUN_DIR/$name.log"
  setsid nohup npm start >"$log" 2>&1 &
  echo $! >"$RUN_DIR/$name.pid"
  sleep 3
  if ! kill -0 "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null; then
    echo "ERROR: $name exited during startup. Last log lines:" >&2
    tail -n 20 "$log" >&2
    exit 1
  fi
  echo "$name started (pid $(cat "$RUN_DIR/$name.pid")), log: $log"
}

start_backend() {
  cd "$REPO_ROOT/backend"
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
  fi
  for var in DB_HOST DB_USER DB_PASSWORD; do
    if [[ -z "${!var:-}" ]]; then
      echo "ERROR: $var is not set (put it in backend/.env or export it)" >&2
      exit 1
    fi
  done
  export PORT="$BACKEND_PORT"

  npm install
  start_server backend
}

start_frontend() {
  cd "$REPO_ROOT/frontend"
  export PORT="$FRONTEND_PORT"
  export BACKEND_URL="http://127.0.0.1:$BACKEND_PORT"

  if ss -ltn "sport = :$FRONTEND_PORT" | grep -q LISTEN; then
    echo "ERROR: port $FRONTEND_PORT is already in use:" >&2
    ss -ltnp "sport = :$FRONTEND_PORT" >&2
    exit 1
  fi

  # Binding port 80 as non-root needs cap_net_bind_service on the node binary.
  local node_bin
  node_bin="$(readlink -f "$(command -v node)")"
  if [[ $EUID -ne 0 ]] && command -v getcap >/dev/null && ! getcap "$node_bin" | grep -q cap_net_bind_service; then
    echo "ERROR: node cannot bind port $FRONTEND_PORT. Run once:" >&2
    echo "  sudo setcap 'cap_net_bind_service=+ep' $node_bin" >&2
    exit 1
  fi

  npm install
  npm run build
  start_server frontend
}

main() {
  mkdir -p "$RUN_DIR"
  cd "$REPO_ROOT"
  git pull --ff-only

  stop_server backend
  stop_server frontend

  (start_backend)
  (start_frontend)
}

main "$@"
