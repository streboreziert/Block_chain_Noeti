#!/usr/bin/env bash
# Start a shareable Noetis network on this machine (host / seed node)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PUBLIC_HOST="${PUBLIC_HOST:-${NOETIS_PUBLIC_HOST:-}}"
if [[ -z "$PUBLIC_HOST" ]]; then
  PUBLIC_HOST="$(curl -fsSL -4 ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"
  echo "Detected PUBLIC_HOST=$PUBLIC_HOST (override with: export PUBLIC_HOST=your.ip)"
fi

export NOETIS_PUBLIC_HOST="$PUBLIC_HOST"
export INTERNAL_DISPATCH_TOKEN="${INTERNAL_DISPATCH_TOKEN:-$(openssl rand -hex 16 2>/dev/null || echo dev-token-change-me)}"

echo "═══════════════════════════════════════════════════"
echo " NOETIS NETWORK HOST"
echo "═══════════════════════════════════════════════════"
echo " Share with friends:"
echo "   P2P:         ws://${PUBLIC_HOST}:4001"
echo "   Coordinator: ws://${PUBLIC_HOST}:3002/ws"
echo "   API:         http://${PUBLIC_HOST}:3001"
echo "   Dashboard:   http://${PUBLIC_HOST}:3000"
echo ""
echo " Friend compute node install:"
echo "   curl -fsSL https://raw.githubusercontent.com/streboreziert/Block_chain_Noeti/main/rust/scripts/install-linux.sh | bash -s -- compute --bootstrap ws://${PUBLIC_HOST}:4001 --coordinator ws://${PUBLIC_HOST}:3002/ws --p2p-port 4010 --run"
echo "═══════════════════════════════════════════════════"
echo " INTERNAL_DISPATCH_TOKEN=$INTERNAL_DISPATCH_TOKEN"
echo " (set same value on API + coordinator)"
echo "═══════════════════════════════════════════════════"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  export NEXT_PUBLIC_API_URL="http://${PUBLIC_HOST}:3001"
  docker compose up -d postgres redis fullnode1 api coordinator validator web
  echo "Docker stack starting. Run migrations if first time:"
  echo "  npm run build -w @noetis/database && node packages/database/dist/migrate.js"
else
  echo "Docker not available — starting via npm (requires Postgres + Redis)."
  echo "Run in separate terminals:"
  echo "  INTERNAL_DISPATCH_TOKEN=$INTERNAL_DISPATCH_TOKEN ./scripts/start-backend.sh"
  echo "  INTERNAL_DISPATCH_TOKEN=$INTERNAL_DISPATCH_TOKEN npm run dev -w @noetis/coordinator"
  echo "  npm run dev -w @noetis/validator"
  echo "  NOETIS_PUBLIC_HOST=$PUBLIC_HOST npm run dev -w @noetis/full-node -- start --seed --validator"
  echo "  NEXT_PUBLIC_API_URL=http://${PUBLIC_HOST}:3001 npm run dev -w @noetis/web"
fi
