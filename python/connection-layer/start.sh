#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v ollama >/dev/null 2>&1; then
  echo "Install Ollama first: brew install ollama"
  exit 1
fi

if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Starting Ollama…"
  brew services start ollama
  sleep 2
fi

if ! ollama list 2>/dev/null | grep -q "qwen2.5:0.5b"; then
  echo "Pulling model qwen2.5:0.5b (~400MB)…"
  ollama pull qwen2.5:0.5b
fi

pip install -q -r requirements.txt 2>/dev/null || pip install -r requirements.txt

echo ""
echo "Open http://127.0.0.1:5051"
echo ""

exec python3 web.py --workers 10 --model qwen2.5:0.5b "$@"
