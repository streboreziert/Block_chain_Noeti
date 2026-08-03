#!/usr/bin/env python3
"""Web dashboard — visualize socket workers and decentralized Ollama inference."""

from __future__ import annotations

import argparse
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from coordinator import Coordinator, DEFAULT_HOST, DEFAULT_PORT, ThreadedServer
from utils.ollama_client import OllamaClient

ROOT = Path(__file__).parent
DEFAULT_MODEL = "qwen2.5:0.5b"
app = Flask(__name__, template_folder=str(ROOT / "templates"), static_folder=str(ROOT / "static"))

coordinator = Coordinator(DEFAULT_HOST, DEFAULT_PORT)
_socket_server: ThreadedServer | None = None
_worker_processes: list[subprocess.Popen] = []
_workers_lock = threading.Lock()


def ensure_socket_server() -> None:
    global _socket_server
    if _socket_server is not None:
        return

    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            coordinator.handle_connection(self.request, self.client_address)

    _socket_server = ThreadedServer((DEFAULT_HOST, DEFAULT_PORT), Handler)
    thread = threading.Thread(target=_socket_server.serve_forever, daemon=True, name="coordinator-socket")
    thread.start()


def _prune_workers() -> list[subprocess.Popen]:
    with _workers_lock:
        _worker_processes[:] = [p for p in _worker_processes if p.poll() is None]
        return list(_worker_processes)


def start_workers(count: int = 10, model: str = DEFAULT_MODEL) -> dict:
    ollama = OllamaClient(model=model)
    mode = "ollama"
    if not ollama.is_available():
        mode = "simulated"
        model = "simulated-local"
    else:
        try:
            model = ollama.resolve_model([model, "qwen2.5:0.5b", "llama3.2:1b"])
        except Exception as exc:
            mode = "simulated"
            model = "simulated-local"
            print(f"Ollama model fallback to simulated mode: {exc}")

    ensure_socket_server()
    stop_workers()
    time.sleep(0.3)

    worker_script = ROOT / "worker.py"
    started = 0

    with _workers_lock:
        for index in range(1, count + 1):
            worker_id = f"worker-{index:02d}"
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(worker_script),
                    "--id",
                    worker_id,
                    "--host",
                    DEFAULT_HOST,
                    "--port",
                    str(DEFAULT_PORT),
                    "--model",
                    model,
                ],
                cwd=str(ROOT),
            )
            _worker_processes.append(process)
            started += 1

    time.sleep(1.5)
    connected = coordinator.worker_count()
    warning = None
    if not connected:
        warning = "Workers launched but not connected yet — wait a few seconds."
    elif mode == "simulated":
        warning = "Running in simulated inference mode (Ollama offline). Install Ollama for real LLM output."

    return {
        "ok": True,
        "started": started,
        "connected": connected,
        "model": model,
        "mode": mode,
        "warning": warning,
    }


def stop_workers() -> None:
    with _workers_lock:
        for process in _worker_processes:
            if process.poll() is None:
                process.terminate()
        _worker_processes.clear()


@app.get("/api/chain")
def api_chain():
    from inference_chain import get_chain

    return jsonify(get_chain().snapshot())


@app.get("/api/transactions")
def api_transactions():
    from datetime import datetime

    from mlc import get_ledger

    entries = get_ledger(limit=50)
    for entry in entries:
        entry["time_str"] = datetime.fromtimestamp(entry["time"]).strftime("%H:%M:%S")
    return jsonify({"transactions": entries, "token": "MLC"})


@app.get("/api/architecture")
def api_architecture():
    return jsonify(
        {
            "layers": [
                {
                    "name": "Client",
                    "role": "Submits AI prompts to the network",
                },
                {
                    "name": "Coordinator",
                    "role": "TCP socket server — routes tasks, verifies consensus",
                },
                {
                    "name": "Workers",
                    "role": "Independent processes running Ollama inference",
                },
                {
                    "name": "Blockchain",
                    "role": "Proof-of-Inference chain — records tasks and hashes",
                },
                {
                    "name": "MLC token",
                    "role": "Rewards faster workers who match consensus",
                },
            ],
            "consensus": "Majority vote on inference outputs",
            "proof_type": "proof_of_inference",
            "token": "MLC",
        }
    )


@app.get("/")
def index():
    return render_template("dashboard.html")


@app.get("/api/status")
def api_status():
    ollama = OllamaClient()
    ollama_ok = ollama.is_available()
    model = None
    if ollama_ok:
        try:
            model = ollama.resolve_model([DEFAULT_MODEL, "llama3.2:1b"])
        except Exception:
            model = None

    alive = len(_prune_workers())
    return jsonify(
        {
            **coordinator.snapshot(),
            "ollama_available": ollama_ok,
            "ollama_model": model,
            "worker_processes": alive,
        }
    )


@app.post("/api/workers/start")
def api_workers_start():
    payload = request.get_json(force=True) if request.is_json else {}
    count = max(1, min(int(payload.get("count", 10)), 10))
    model = str(payload.get("model", DEFAULT_MODEL))
    result = start_workers(count=count, model=model)
    status = 400 if not result.get("ok") else 200
    return jsonify({**result, **coordinator.snapshot()}), status


@app.post("/api/workers/stop")
def api_workers_stop():
    stop_workers()
    return jsonify({"ok": True, **coordinator.snapshot()})


@app.post("/api/prompt")
def api_prompt():
    payload = request.get_json(force=True)
    prompt = str(payload.get("text", "")).strip()
    if not prompt:
        return jsonify({"error": "text required"}), 400

    if coordinator.worker_count() == 0:
        return jsonify({"error": "No workers connected. Click ‘Start 10 workers’ first."}), 400

    if coordinator.running_task:
        return jsonify({"error": "Task already running"}), 400

    ensure_socket_server()

    def _run() -> None:
        coordinator.run_dispatch(prompt)

    threading.Thread(target=_run, daemon=True, name="dispatch-task").start()
    return jsonify({"ok": True, "started": True, "message": "Task dispatched to workers"})


def main() -> None:
    parser = argparse.ArgumentParser(description="Decentralized inference web dashboard")
    parser.add_argument("--web-port", type=int, default=5051)
    parser.add_argument("--workers", type=int, default=10, help="Auto-start N workers on launch")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    ensure_socket_server()

    ollama = OllamaClient()
    if not ollama.is_available():
        print("Warning: Ollama not reachable. Run: brew services start ollama")
    else:
        try:
            print(f"Ollama ready. Model: {ollama.resolve_model([args.model])}")
        except Exception as exc:
            print(f"Ollama warning: {exc}")

    if args.workers > 0:
        result = start_workers(count=args.workers, model=args.model)
        print(f"Workers: started={result.get('started')} connected={result.get('connected')}")
        if result.get("warning"):
            print(result["warning"])

    print(f"Web dashboard: http://127.0.0.1:{args.web_port}")
    print(f"Socket coordinator: {DEFAULT_HOST}:{DEFAULT_PORT}")
    app.run(host="127.0.0.1", port=args.web_port, threaded=True)


if __name__ == "__main__":
    main()
