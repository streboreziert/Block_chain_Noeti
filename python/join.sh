#!/usr/bin/env bash
# Noetis one-line onboarding:  curl -sSL https://noeticompute.com/join.sh | bash
# Prefers the packaged Rust apps when available; falls back to Python clone.
set -euo pipefail

HUB="${NOETIS_HUB:-https://noeticompute.com}"

echo ""
echo "  Noetis — Decentralized AI Network"
echo "  Hub: ${HUB}"
echo ""

# Prefer desktop installer (Rust binaries).
if curl -fsSL "${HUB}/install.sh" -o /tmp/noetis-install.sh 2>/dev/null; then
  echo "  → Installing Noetis apps…"
  bash /tmp/noetis-install.sh
  exit 0
fi

# Fallback: Python network tools
REPO="https://github.com/streboreziert/Block_chain_Noeti.git"
BRANCH="main"
DIR="Block_chain_Noeti"

command -v git >/dev/null 2>&1 || { echo "  Error: git not found — install git first."; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "  Error: python3 not found — install Python 3.10+."; exit 1; }

if [ -d "$DIR" ]; then
  echo "  → Updating existing clone"
  git -C "$DIR" pull --ff-only || true
else
  echo "  → Cloning ${REPO} (${BRANCH})"
  git clone -b "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR/python"
echo "  → Installing dependencies"
pip3 install -r requirements.txt -q

echo ""
echo "  Ready. Choose a role:"
echo "    User (chat):     python3 launch.py user --hub ${HUB} --open"
echo "    Compute (earn):  python3 launch.py compute --hub ${HUB} --id my-gpu"
echo "    Relay (privacy): python3 launch.py relay --hub ${HUB} --id my-relay"
echo "    Verify chain:    python3 launch.py sync --hub ${HUB} --light"
echo ""

if [ -t 0 ]; then
  read -r -p "  Launch the user app now? [Y/n] " answer
  case "${answer:-Y}" in
    [Yy]*) python3 launch.py user --hub "$HUB" --open ;;
    *) echo "  Run any command above when ready." ;;
  esac
else
  echo "  (non-interactive shell — run a command above to start)"
fi
