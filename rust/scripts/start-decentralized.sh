#!/usr/bin/env bash
# Start decentralized network: 3 full nodes + API + processing nodes
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Noetis Decentralized Network"
docker compose up -d postgres redis fullnode1 fullnode2 fullnode3
sleep 3

npm run build -w @noetis/full-node 2>/dev/null || npm run build

echo "Full nodes:"
echo "  fullnode1: http://localhost:4000  P2P ws://localhost:4001"
echo "  fullnode2: http://localhost:4010  P2P ws://localhost:4011"
echo "  fullnode3: http://localhost:4020  P2P ws://localhost:4021"
echo ""
echo "Friends connect with:"
echo "  noetis-full-node start --bootstrap ws://YOUR_IP:4001 --validator --p2p-port 4002"
echo "  noetis-node start --p2p-bootstrap ws://YOUR_IP:4001 --coordinator ws://YOUR_IP:3002/ws"
