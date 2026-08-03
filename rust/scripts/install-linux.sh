#!/usr/bin/env bash
# Noetis Compute — shareable Linux installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/streboreziert/Block_chain_Noeti/main/rust/scripts/install-linux.sh | bash
#   curl -fsSL .../install-linux.sh | bash -s -- compute --bootstrap ws://HOST:4001 --coordinator ws://HOST:3002/ws
#   curl -fsSL .../install-linux.sh | bash -s -- full-node --bootstrap ws://HOST:4001
set -euo pipefail

REPO_URL="${NOETIS_REPO:-https://github.com/streboreziert/Block_chain_Noeti.git}"
INSTALL_DIR="${NOETIS_HOME:-$HOME/.noetis/compute-lab}"
BIN_DIR="${NOETIS_BIN_DIR:-$HOME/.local/bin}"
BRANCH="${NOETIS_BRANCH:-main}"

MODE="compute"
BOOTSTRAP=""
COORDINATOR=""
OLLAMA="http://localhost:11434"
WALLET_DIR=""
RUN_AFTER=0
SEED=0
P2P_PORT=4001
HTTP_PORT=4000

usage() {
  cat <<'EOF'
Noetis Compute — Linux installer

Usage:
  bash install-linux.sh [mode] [options]

Modes:
  compute      Install AI processing node (noetis-node)     [default]
  full-node    Install blockchain full node (noetis-full-node)

Options:
  --bootstrap <ws-url>     P2P bootstrap peer (required unless --seed)
  --coordinator <ws-url>   Coordinator WebSocket (compute mode)
  --ollama <url>           Ollama URL (default: http://localhost:11434)
  --wallet <path>          Wallet file path
  --install-dir <path>     Clone directory (default: ~/.noetis/compute-lab)
  --bin-dir <path>         Binary symlink dir (default: ~/.local/bin)
  --p2p-port <n>           P2P port for full-node seed (default: 4001)
  --http-port <n>          HTTP port for full-node seed (default: 4000)
  --seed                     Start as first full-node validator (no bootstrap)
  --run                      Start the node after install
  -h, --help                 Show this help

Shareable one-liners:
  # Join network as compute node
  curl -fsSL https://raw.githubusercontent.com/streboreziert/Block_chain_Noeti/main/rust/scripts/install-linux.sh | bash -s -- compute --bootstrap ws://HOST:4001 --coordinator ws://HOST:3002/ws --run

  # Join as full validator node
  curl -fsSL https://raw.githubusercontent.com/streboreziert/Block_chain_Noeti/main/rust/scripts/install-linux.sh | bash -s -- full-node --bootstrap ws://HOST:4001 --run

  # Seed a new network (first validator)
  curl -fsSL https://raw.githubusercontent.com/streboreziert/Block_chain_Noeti/main/rust/scripts/install-linux.sh | bash -s -- full-node --seed --run
EOF
}

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR>\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    compute|full-node) MODE="$1"; shift ;;
    --bootstrap) BOOTSTRAP="${2:-}"; shift 2 ;;
    --coordinator) COORDINATOR="${2:-}"; shift 2 ;;
    --ollama) OLLAMA="${2:-}"; shift 2 ;;
    --wallet) WALLET_DIR="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:-}"; shift 2 ;;
    --p2p-port) P2P_PORT="${2:-}"; shift 2 ;;
    --http-port) HTTP_PORT="${2:-}"; shift 2 ;;
    --seed) SEED=1; shift ;;
    --run) RUN_AFTER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
done

if [[ "$MODE" == "compute" && -z "$COORDINATOR" && -n "$BOOTSTRAP" ]]; then
  host="${BOOTSTRAP#ws://}"
  host="${host#wss://}"
  host="${host%%/*}"
  host="${host%%:*}"
  COORDINATOR="ws://${host}:3002/ws"
fi

if [[ "$MODE" == "full-node" && "$SEED" -eq 0 && -z "$BOOTSTRAP" ]]; then
  die "full-node requires --bootstrap ws://HOST:PORT or --seed"
fi

if [[ "$MODE" == "compute" && -z "$BOOTSTRAP" ]]; then
  die "compute node requires --bootstrap ws://HOST:4001 (and --coordinator ws://HOST:3002/ws for remote networks)"
fi

if [[ "$MODE" == "compute" && -z "$COORDINATOR" ]]; then
  die "compute node requires --coordinator ws://HOST:3002/ws (task delivery from network host)"
fi

command -v node >/dev/null 2>&1 || true
command -v cargo >/dev/null 2>&1 || die "Rust/cargo not found. Install: curl -fsSL https://sh.rustup.rs | sh"
command -v git >/dev/null 2>&1 || die "git not found. Install: sudo apt install git  (or your distro equivalent)"

if [[ "$MODE" == "compute" ]] && ! command -v ollama >/dev/null 2>&1; then
  warn "Ollama not found. Install from https://ollama.com then: ollama pull llama3.2:3b"
fi

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "Updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH" || true
else
  log "Cloning Noetis Compute to $INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR/rust"
log "Building Rust binaries (release)..."
source "$HOME/.cargo/env" 2>/dev/null || true

if [[ "$MODE" == "compute" ]]; then
  cargo build --release -p noetis-node
  BIN="$INSTALL_DIR/rust/target/release/noetis-node"
  WRAPPER_NAME="noetis-node"
  WALLET="${WALLET_DIR:-$INSTALL_DIR/data/node/wallet.json}"
  START_CMD=("$BIN" start
    --coordinator "${COORDINATOR}"
    --p2p-bootstrap "$BOOTSTRAP"
    --p2p-port "$P2P_PORT"
    --ollama "$OLLAMA"
    --wallet "$WALLET")
else
  cargo build --release -p noetis-full-node
  BIN="$INSTALL_DIR/rust/target/release/noetis-full-node"
  WRAPPER_NAME="noetis-full-node"
  WALLET="${WALLET_DIR:-$INSTALL_DIR/data/full-node/wallet.json}"
  DATA="$INSTALL_DIR/data/full-node/chain"
  if [[ "$SEED" -eq 1 ]]; then
    START_CMD=("$BIN" start --data "$DATA" --p2p-port "$P2P_PORT" --http-port "$HTTP_PORT" --validator --wallet "$WALLET")
  else
    START_CMD=("$BIN" start --bootstrap "$BOOTSTRAP" --data "$DATA" --p2p-port "$P2P_PORT" --http-port "$HTTP_PORT" --validator --wallet "$WALLET")
  fi
fi

WRAPPER="$BIN_DIR/$WRAPPER_NAME"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$BIN" "\$@"
EOF
chmod +x "$WRAPPER"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "Add $BIN_DIR to your PATH:"
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
fi

log "Installed $WRAPPER_NAME → $WRAPPER"
echo ""
echo "────────────────────────────────────────"
echo " START COMMAND (copy & share):"
echo "────────────────────────────────────────"
printf ' %q' "${START_CMD[@]}"
echo ""
echo ""
echo "Or with wrapper:"
printf ' %q' "$WRAPPER_NAME" start
if [[ "$MODE" == "compute" ]]; then
  echo " --coordinator ${COORDINATOR:-ws://localhost:3002/ws} --p2p-bootstrap $BOOTSTRAP --ollama $OLLAMA --wallet $WALLET"
else
  if [[ "$SEED" -eq 1 ]]; then
    echo " --data $DATA --p2p-port $P2P_PORT --http-port $HTTP_PORT --validator --wallet $WALLET"
  else
    echo " --bootstrap $BOOTSTRAP --data $DATA --p2p-port $P2P_PORT --http-port $HTTP_PORT --validator --wallet $WALLET"
  fi
fi
echo "────────────────────────────────────────"

if [[ "$RUN_AFTER" -eq 1 ]]; then
  log "Starting $WRAPPER_NAME..."
  exec "${START_CMD[@]}"
fi
