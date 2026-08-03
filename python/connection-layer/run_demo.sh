#!/usr/bin/env bash
# Start coordinator + N workers for local decentralized inference demo.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-9600}"
WORKERS="${WORKERS:-10}"
MODEL="${MODEL:-llama3.2:1b}"

if ! curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
  echo "Ollama is not running."
  echo "Install: https://ollama.com"
  echo "Then run:  ollama pull ${MODEL}"
  exit 1
fi

echo "Starting coordinator on ${HOST}:${PORT}"
python3 coordinator.py --host "$HOST" --port "$PORT" &
COORD_PID=$!
sleep 1

PIDS=()
for i in $(seq 1 "$WORKERS"); do
  WORKER_ID=$(printf "worker-%02d" "$i")
  python3 worker.py --id "$WORKER_ID" --host "$HOST" --port "$PORT" --model "$MODEL" &
  PIDS+=($!)
done

sleep 2
echo ""
echo "Ready: ${WORKERS} workers connected to coordinator."
echo "Submit a prompt:"
echo "  python3 client.py \"Explain proof-of-learning in one sentence.\""
echo ""
echo "Press Ctrl+C to stop."

cleanup() {
  echo "Stopping..."
  kill "$COORD_PID" 2>/dev/null || true
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

wait "$COORD_PID"
