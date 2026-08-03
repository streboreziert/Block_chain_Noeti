#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Starting Noetis Compute local network"
echo "Requires: Node 20+, Docker, Ollama with at least one model (ollama pull llama3.2:3b)"

if ! command -v ollama &>/dev/null; then
  echo "WARNING: Ollama not found. Nodes will register but cannot process tasks."
fi

docker compose up -d postgres redis
echo "Waiting for postgres..."
sleep 5

npm install
npm run build -w @noetis/protocol -w @noetis/crypto -w @noetis/currency -w @noetis/blockchain \
  -w @noetis/scheduler -w @noetis/ollama-client -w @noetis/database \
  -w @noetis/api -w @noetis/coordinator -w @noetis/validator -w @noetis/node

npm run build -w @noetis/database && node packages/database/dist/migrate.js

echo "Starting services..."
npx concurrently -k \
  "npm run dev -w @noetis/api" \
  "npm run dev -w @noetis/coordinator" \
  "npm run dev -w @noetis/validator" \
  "npm run dev -w @noetis/web" \
  "npm run dev -w @noetis/node -- --coordinator ws://localhost:3002/ws --wallet ./data/sim-node-1/wallet.json --ollama http://localhost:11434" \
  "npm run dev -w @noetis/node -- --coordinator ws://localhost:3002/ws --wallet ./data/sim-node-2/wallet.json --ollama http://localhost:11434" \
  "npm run dev -w @noetis/node -- --coordinator ws://localhost:3002/ws --wallet ./data/sim-node-3/wallet.json --ollama http://localhost:11434"
