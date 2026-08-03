#!/usr/bin/env bash
# One-line connect: curl -sSL https://noeticompute.com/device-agent.sh | bash -s -- SESSION TOKEN
set -euo pipefail
SESSION="${1:-}"
TOKEN="${2:-}"
HUB="${NOETI_HUB:-https://noeticompute.com}"
HUB="${HUB%/}"

if [[ -z "$SESSION" || -z "$TOKEN" ]]; then
  echo "Usage: bash device-agent.sh SESSION TOKEN"
  echo "Or open the pair link from Canvas → Connect PC"
  exit 2
fi

echo "→ Noeti device agent"
echo "  hub $HUB"
echo "  session $SESSION"

# Prefer python3
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 required. Install Python, then re-run."
  exit 1
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "→ Downloading agent"
curl -fsSL "$HUB/device_agent.py" -o "$TMP/device_agent.py"

if ! curl -fsS "${OLLAMA_HOST:-http://127.0.0.1:11434}/api/tags" >/dev/null 2>&1; then
  echo ""
  echo "Ollama not detected on this PC."
  echo "  1) Install: https://ollama.com"
  echo "  2) Run:    ollama serve"
  echo "  3) Pull:   ollama pull qwen2.5:1.5b"
  echo ""
  echo "Agent will keep trying…"
fi

echo "→ Connecting to Canvas (Ctrl+C to stop)"
exec python3 "$TMP/device_agent.py" --hub "$HUB" --session "$SESSION" --token "$TOKEN"
