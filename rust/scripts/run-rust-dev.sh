#!/usr/bin/env bash
# Start Noetis Compute (Rust) locally
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$HOME/.cargo/env" 2>/dev/null || true

export DATABASE_URL="${DATABASE_URL:-postgresql://noetis:noetis@localhost:5432/noetis}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export RUST_LOG="${RUST_LOG:-info}"

echo "Building Rust release binaries..."
cargo build --release -p noetis-db -p noetis-api -p noetis-coordinator -p noetis-validator -p noetis-full-node -p noetis-web

echo "Running migrations..."
cargo run --release -p noetis-db -- migrate 2>/dev/null || \
  psql "$DATABASE_URL" -f crates/noetis-db/src/schema.sql 2>/dev/null || true

echo "Start each service in a separate terminal:"
echo "  ./target/release/noetis-full-node start --validator --p2p-port 4001 --http-port 4000"
echo "  ./target/release/noetis-coordinator"
echo "  ./target/release/noetis-validator"
echo "  ./target/release/noetis-api"
echo "  ./target/release/noetis-web"
echo "  ./target/release/noetis-node start --coordinator ws://localhost:3002/ws --p2p-bootstrap ws://localhost:4001"
