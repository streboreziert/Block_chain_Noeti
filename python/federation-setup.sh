#!/usr/bin/env bash
# Wire two Noetis hubs for multi-writer federation (cosign quorum = 2).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

PRIMARY_URL="${PRIMARY_URL:-https://noeticompute.com}"
PEER_URL="${PEER_URL:-https://peer.noeticompute.com}"
PEER_URL_DIRECT="${PEER_URL_DIRECT:-http://127.0.0.1:5055}"
PRIMARY_REMOTE="${PRIMARY_REMOTE:?Set PRIMARY_REMOTE (e.g. root@YOUR_SERVER_IP)}"
PEER_REMOTE="${PEER_REMOTE:-$PRIMARY_REMOTE}"
REMOTE_DIR="${REMOTE_DIR:-/data/sites/noeticompute}"
COSIGN_QUORUM="${COSIGN_QUORUM:-2}"
PRIMARY_CONTAINER="${PRIMARY_CONTAINER:-noetis-network}"
PEER_CONTAINER="${PEER_CONTAINER:-noetis-network-peer}"
MESH_PORT_PRIMARY="${MESH_PORT_PRIMARY:-5053}"
MESH_PORT_PEER="${MESH_PORT_PEER:-5054}"
USE_PEER_DIRECT="${USE_PEER_DIRECT:-auto}"

log() { echo "→ $*"; }
fail() { echo "✗ $*" >&2; exit 1; }

url_ok() {
  curl -sf --max-time 12 "$1/api/health" >/dev/null 2>&1
}

pick_peer_url() {
  if [[ "$USE_PEER_DIRECT" == "1" ]]; then
    echo "$PEER_URL_DIRECT"
    return
  fi
  if [[ "$USE_PEER_DIRECT" == "0" ]] && url_ok "$PEER_URL"; then
    echo "$PEER_URL"
    return
  fi
  if url_ok "$PEER_URL"; then
    echo "$PEER_URL"
    return
  fi
  if url_ok "$PEER_URL_DIRECT"; then
    echo "$PEER_URL_DIRECT"
    return
  fi
  fail "Peer hub not reachable at $PEER_URL or $PEER_URL_DIRECT"
}

write_env_files() {
  local peer_effective="$1"
  log "Writing federation env on ${PRIMARY_REMOTE}:${REMOTE_DIR}"
  ssh "$PRIMARY_REMOTE" "cat > ${REMOTE_DIR}/.env.federation" <<EOF
FEDERATION_PEERS=${peer_effective}
COSIGN_QUORUM=${COSIGN_QUORUM}
MESH_CONSENSUS=1
BOOTSTRAP_PEERS=${PRIMARY_URL},${peer_effective}
EOF
  ssh "$PRIMARY_REMOTE" "cat > ${REMOTE_DIR}/.env.federation.peer" <<EOF
FEDERATION_PEERS=${PRIMARY_URL}
COSIGN_QUORUM=${COSIGN_QUORUM}
MESH_CONSENSUS=1
CANONICAL_HUB_URL=${PRIMARY_URL}
PEER_PUBLIC_URL=${peer_effective}
BOOTSTRAP_PEERS=${PRIMARY_URL},${peer_effective}
EOF
}

open_mesh_ports() {
  local remote="$1"
  log "Opening gossip mesh ports ${MESH_PORT_PRIMARY}/${MESH_PORT_PEER} on ${remote}"
  ssh "$remote" "command -v ufw >/dev/null 2>&1 && ufw allow ${MESH_PORT_PRIMARY}/tcp && ufw allow ${MESH_PORT_PEER}/tcp || true"
  ssh "$remote" "command -v ufw >/dev/null 2>&1 && ufw allow 5055/tcp || true"
}

sync_project() {
  log "Syncing project to ${PRIMARY_REMOTE}:${REMOTE_DIR}"
  rsync -avz --delete \
    --exclude '.git' \
    --exclude 'connection-layer/data/chain.json' \
    --exclude 'connection-layer/data/wallets.json' \
    --exclude 'connection-layer/data/transactions.json' \
    --exclude 'connection-layer/data/wallets/' \
    "${ROOT}/" "${PRIMARY_REMOTE}:${REMOTE_DIR}/"
}

deploy_hubs() {
  log "Building primary + peer containers"
  ssh "$PRIMARY_REMOTE" "cd ${REMOTE_DIR} && docker compose -f docker-compose.prod.yml up -d --build --remove-orphans"
  ssh "$PRIMARY_REMOTE" "cd ${REMOTE_DIR} && docker compose -f docker-compose.peer.yml up -d --build --remove-orphans"
}

wait_healthy() {
  local url="$1"
  local label="$2"
  log "Waiting for ${label} (${url})"
  for _ in $(seq 1 30); do
    if url_ok "$url"; then
      echo "  ✓ ${label} healthy"
      return 0
    fi
    sleep 2
  done
  fail "${label} did not become healthy at ${url}"
}

join_federation() {
  local container="$1"
  local peer="$2"
  local public="$3"
  local remote="$4"
  log "Join ${container}: register with ${peer} as ${public}"
  ssh "$remote" "docker exec ${container} python3 federation_cli.py join --peer '${peer}' --public-url '${public}'"
}

sync_chains() {
  local peer_effective="$1"
  log "Unify chains — canonical hub ${PRIMARY_URL}"
  ssh "$PRIMARY_REMOTE" "docker exec ${PRIMARY_CONTAINER} python3 federation_cli.py sync-chains --public-url '${PRIMARY_URL}'"
  ssh "$PEER_REMOTE" "docker exec ${PEER_CONTAINER} python3 federation_cli.py sync-chains --public-url '${peer_effective}'"
  ssh "$PEER_REMOTE" "docker exec ${PEER_CONTAINER} python3 sync_node.py --hub '${PRIMARY_URL}' --once"
}

verify_chains_match() {
  local peer_url="$1"
  log "Verifying both hubs share the same chain tip"
  local primary_tip peer_tip
  for attempt in $(seq 1 15); do
    primary_tip="$(curl -sf "${PRIMARY_URL}/api/chain" | python3 -c "import sys,json; b=json.load(sys.stdin).get('blocks',[]); print(b[-1]['hash'] if b else '')")"
    peer_tip="$(curl -sf "${peer_url}/api/chain" | python3 -c "import sys,json; b=json.load(sys.stdin).get('blocks',[]); print(b[-1]['hash'] if b else '')")"
    if [[ -n "$primary_tip" && "$primary_tip" == "$peer_tip" ]]; then
      echo "  ✓ Chain unified — tip ${primary_tip:0:16}…"
      return 0
    fi
    sleep 2
  done
  fail "Chain mismatch after retries — primary ${primary_tip:0:16}… vs peer ${peer_tip:0:16}…"
}

verify_federation() {
  local url="$1"
  local label="$2"
  log "Validators at ${label}"
  curl -sf "${url}/api/validators" | python3 -m json.tool | head -40
  curl -sf "${url}/api/mesh" | python3 -m json.tool | head -20
}

main() {
  echo ""
  echo "Noetis federation setup"
  echo "  Primary: ${PRIMARY_URL}"
  echo "  Peer:    ${PEER_URL} (fallback ${PEER_URL_DIRECT})"
  echo "  Quorum:  ${COSIGN_QUORUM}"
  echo ""

  sync_project
  open_mesh_ports "$PRIMARY_REMOTE"

  local peer_effective="${PEER_URL_DIRECT}"
  if [[ "$USE_PEER_DIRECT" == "0" ]] && url_ok "$PEER_URL" 2>/dev/null; then
    peer_effective="$PEER_URL"
  elif [[ "$USE_PEER_DIRECT" != "1" ]] && url_ok "$PEER_URL" 2>/dev/null; then
    peer_effective="$PEER_URL"
  fi
  write_env_files "$peer_effective"

  deploy_hubs

  wait_healthy "$PRIMARY_URL" "primary hub"

  if ! url_ok "$peer_effective"; then
    if url_ok "$PEER_URL"; then
      peer_effective="$PEER_URL"
    elif url_ok "$PEER_URL_DIRECT"; then
      peer_effective="$PEER_URL_DIRECT"
    else
      fail "Peer hub not reachable at $PEER_URL or $PEER_URL_DIRECT"
    fi
    write_env_files "$peer_effective"
    deploy_hubs
  fi

  log "Using peer URL: ${peer_effective}"

  join_federation "$PRIMARY_CONTAINER" "$peer_effective" "$PRIMARY_URL" "$PRIMARY_REMOTE"
  join_federation "$PEER_CONTAINER" "$PRIMARY_URL" "$peer_effective" "$PEER_REMOTE"

  sync_chains "$peer_effective"

  log "Restarting hubs to apply federation registry + env"
  ssh "$PRIMARY_REMOTE" "cd ${REMOTE_DIR} && docker compose -f docker-compose.prod.yml restart network && docker compose -f docker-compose.peer.yml restart network-peer"
  sleep 5

  wait_healthy "$PRIMARY_URL" "primary hub"
  wait_healthy "$peer_effective" "peer hub"

  sync_chains "$peer_effective"
  verify_chains_match "$peer_effective"

  verify_federation "$PRIMARY_URL" "primary"
  verify_federation "$peer_effective" "peer"

  echo ""
  echo "Done — multi-writer federation active."
  echo "  Primary: ${PRIMARY_URL}/api/validators"
  echo "  Peer:    ${peer_effective}/api/validators"
  echo "  Quorum:  COSIGN_QUORUM=${COSIGN_QUORUM}  MESH_CONSENSUS=1"
  echo ""
  echo "Same-host dual validator (current): peer compose shares this machine."
  echo "Second physical machine later:"
  echo "  1) Copy docker-compose.peer.yml + .env.federation.peer to host B"
  echo "  2) Point PEER_URL / PEER_PUBLIC_URL at B's public IP (or peer.noeticompute.com)"
  echo "  3) Set FEDERATION_PEERS on primary to B; re-run join + sync-chains"
  echo "  4) Redis: peer can keep REDIS_URL to primary redis host, or run its own"
  echo ""
  if [[ "$peer_effective" == "$PEER_URL_DIRECT" ]]; then
    echo "Note: peer is on direct port ${PEER_URL_DIRECT}."
    echo "Add DNS A record peer.noeticompute.com → YOUR_SERVER_IP for HTTPS peer URL."
    echo "Then: PEER_URL=https://peer.noeticompute.com USE_PEER_DIRECT=0 ./federation-setup.sh"
  fi
}

main "$@"
