#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
PORT="${PORT:-5052}"
pip3 install -q -r requirements.txt 2>/dev/null || pip install -q -r requirements.txt
lsof -ti :"$PORT" | xargs kill 2>/dev/null || true
sleep 1
python3 app.py --host 127.0.0.1 --port "$PORT" --nodes 3 --open "$@"
