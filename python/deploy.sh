#!/usr/bin/env bash
# Deploy Noetis network hub + entry point to Hetzner (noeticompute.com)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REMOTE="${DEPLOY_REMOTE:?Set DEPLOY_REMOTE (e.g. root@YOUR_SERVER_IP)}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/data/sites/noeticompute}"

echo "→ Syncing project to ${REMOTE}:${REMOTE_DIR}"
# Keep remote download zips if a pack is temporarily missing locally
rsync -avz \
  --exclude '.git' \
  --exclude 'connection-layer/data/chain.json' \
  --exclude 'connection-layer/data/wallets.json' \
  --exclude 'connection-layer/data/transactions.json' \
  --exclude 'connection-layer/data/wallets/' \
  --exclude 'connection-layer/data/site_users.json' \
  --exclude 'connection-layer/data/site_sessions.json' \
  --exclude 'connection-layer/data/chat_history.json' \
  --exclude '.team_site_users.env' \
  "${ROOT}/" "${REMOTE}:${REMOTE_DIR}/"

# Still prune stale code, but never wipe html/downloads via --delete
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'html/downloads/' \
  --exclude 'connection-layer/data/chain.json' \
  --exclude 'connection-layer/data/wallets.json' \
  --exclude 'connection-layer/data/transactions.json' \
  --exclude 'connection-layer/data/wallets/' \
  --exclude 'connection-layer/data/site_users.json' \
  --exclude 'connection-layer/data/site_sessions.json' \
  --exclude 'connection-layer/data/chat_history.json' \
  --exclude '.team_site_users.env' \
  "${ROOT}/" "${REMOTE}:${REMOTE_DIR}/"

echo "→ Ensuring download artifacts are readable"
ssh "${REMOTE}" "chmod 755 ${REMOTE_DIR}/html/downloads && chmod a+r ${REMOTE_DIR}/html/downloads/* 2>/dev/null || true"

echo "→ Building and starting primary + peer network containers"
ssh "${REMOTE}" "cd ${REMOTE_DIR} && touch .env.federation .env.federation.peer .env.openrouter 2>/dev/null || true"
ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose -f docker-compose.prod.yml up -d --build --remove-orphans"
ssh "${REMOTE}" "cd ${REMOTE_DIR} && touch .env.federation.peer 2>/dev/null || true; docker compose -f docker-compose.peer.yml up -d --build --remove-orphans || true"

echo "→ Ensuring team site users (if .team_site_users.env present on server)"
# Passwords in .team_site_users.env must be single-quoted (shell metacharacters like & !).
# SITE_USER_FORCE=1 overwrites passwords (makers: admin/admin).
ssh "${REMOTE}" "cd ${REMOTE_DIR} && if [ -f .team_site_users.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.team_site_users.env
  set +a
  export SITE_USER_FORCE=\"\${SITE_USER_FORCE:-1}\"
  docker compose -f docker-compose.prod.yml exec -T \
    -e SITE_USER_ADMIN_PASSWORD \
    -e SITE_USER_TEAM_PASSWORD \
    -e SITE_USER_OPS_PASSWORD \
    -e SITE_USER_FORCE \
    network python3 scripts/create_site_user.py --ensure-team --force
else
  echo '  (no .team_site_users.env — skip team user bootstrap)'
fi"

echo "→ Verifying API"
curl -sf "https://noeticompute.com/api/entry" | head -c 200
echo ""
curl -sf "https://noeticompute.com/api/chain" | head -c 200
echo ""
echo "Done — https://noeticompute.com/entry"
echo ""
echo "Multi-writer federation: ./federation-setup.sh"
echo "  (or FEDERATION_PEERS=https://peer.example.com COSIGN_QUORUM=2 ./deploy.sh)"
