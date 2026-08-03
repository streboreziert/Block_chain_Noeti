#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       Noetis Decentralized AI        ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Choose your role:"
echo ""
echo "    1) Host entry point — run hub + public entry page"
echo "    2) Join as user   — standalone local app (wallet + terminal)"
echo "    3) Join as relay  — route prompts for privacy (3rd party)"
echo "    4) Join as compute — provide GPU/CPU inference"
echo "    5) Sync blockchain — P2P verify /api/chain"
echo "    6) Light sync     — headers + SPV proofs only"
echo "    7) Gossip mesh     — TCP block propagation"
echo "    8) Security check — audit chain, keys, hub hardening"
echo ""
read -r -p "  Enter 1–8: " choice
echo ""

if ! command -v python3 &>/dev/null; then
  echo "  Error: python3 not found."
  read -p "  Press Enter to close..."
  exit 1
fi

pip3 install -r requirements.txt -q 2>/dev/null

PORT=5052
lsof -ti :$PORT | xargs kill 2>/dev/null
sleep 1

case "$choice" in
  1)
    echo "  Entry point: http://127.0.0.1:$PORT/entry"
    echo "  Share LAN URL from terminal output with others."
    echo ""
    python3 launch.py hub --host 0.0.0.0 --port "$PORT" --open
    ;;
  2)
    read -r -p "  Entry URL (leave empty = auto-discover): " HUB
    python3 launch.py user --hub "$HUB" --open
    ;;
  3)
    read -r -p "  Entry URL (leave empty = auto-discover): " HUB
    read -r -p "  Your relay name (e.g. relay-alice): " RELAY
    RELAY="${RELAY:-relay-$(hostname -s)}"
    python3 launch.py relay --hub "$HUB" --id "$RELAY"
    ;;
  4)
    read -r -p "  Entry URL (leave empty = auto-discover): " HUB
    read -r -p "  Your compute node name (e.g. gpu-alice): " NODE
    NODE="${NODE:-compute-$(hostname -s)}"
    if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      echo ""
      echo "  Ollama required for compute. Install: https://ollama.com"
      echo "  Then run: ollama serve && ollama pull qwen2.5:0.5b"
      echo ""
    fi
    python3 launch.py compute --hub "$HUB" --id "$NODE"
    ;;
  5)
    read -r -p "  Entry URL (leave empty = auto-discover): " HUB
    python3 launch.py sync --hub "$HUB"
    ;;
  6)
    read -r -p "  Entry URL (leave empty = auto-discover): " HUB
    python3 launch.py sync --hub "$HUB" --light
    ;;
  7)
    read -r -p "  Entry URL (leave empty = auto-discover): " HUB
    python3 launch.py mesh --hub "$HUB"
    ;;
  8)
    read -r -p "  Hub URL to audit (default https://noeticompute.com): " HUB
    python3 security_check.py --hub "${HUB:-https://noeticompute.com}"
    read -p "  Press Enter to close..."
    ;;
  *)
    echo "  Invalid choice. Run again and pick 1–8."
    read -p "  Press Enter to close..."
    exit 1
    ;;
esac
