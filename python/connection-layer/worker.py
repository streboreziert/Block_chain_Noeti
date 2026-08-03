#!/usr/bin/env python3
"""Worker node — connects to coordinator and runs local inference (Ollama or simulated)."""

from __future__ import annotations

import argparse
import socket
import sys
import time

from utils.inference_backend import create_backend, run_inference
from utils.protocol import read_message, send_message

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9600


def run_worker(
    worker_id: str,
    host: str,
    port: int,
    model: str,
    ollama_url: str,
) -> None:
    backend, info = create_backend(worker_id, model=model, ollama_url=ollama_url)
    resolved = info.model
    print(f"[{worker_id}] backend: {info.mode} — {info.detail}")

    with socket.create_connection((host, port), timeout=10) as conn:
        send_message(
            conn,
            {
                "op": "register",
                "role": "worker",
                "worker_id": worker_id,
                "model": resolved,
            },
        )
        message, buffer = read_message(conn)
        if message.get("op") != "registered":
            raise RuntimeError(f"Registration failed: {message}")

        print(f"[{worker_id}] connected to coordinator at {host}:{port}")

        while True:
            message, buffer = read_message(conn, buffer)
            if message.get("op") != "task":
                continue

            task_id = str(message.get("task_id", ""))
            prompt = str(message.get("prompt", ""))
            print(f"[{worker_id}] task received: {task_id}")

            try:
                started = time.perf_counter()
                inference = run_inference(backend, prompt)
                if inference.inference_ms <= 0:
                    inference.inference_ms = (time.perf_counter() - started) * 1000

                send_message(
                    conn,
                    {
                        "op": "result",
                        "task_id": task_id,
                        "worker_id": worker_id,
                        "response": inference.response,
                        "inference_ms": inference.inference_ms,
                        "model": inference.model,
                    },
                )
                print(
                    f"[{worker_id}] task complete: {task_id} "
                    f"({inference.inference_ms:.0f}ms)"
                )
            except Exception as exc:
                send_message(
                    conn,
                    {
                        "op": "result",
                        "task_id": task_id,
                        "worker_id": worker_id,
                        "response": f"ERROR: {exc}",
                        "inference_ms": 0.0,
                        "model": resolved,
                    },
                )
                print(f"[{worker_id}] inference error: {exc}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Decentralized inference worker")
    parser.add_argument("--id", required=True, dest="worker_id", help="Worker identifier")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", default="llama3.2:1b", help="Ollama model name")
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    args = parser.parse_args()

    while True:
        try:
            run_worker(args.worker_id, args.host, args.port, args.model, args.ollama_url)
        except KeyboardInterrupt:
            print(f"\n[{args.worker_id}] stopped")
            break
        except (ConnectionError, OSError, RuntimeError) as exc:
            print(f"[{args.worker_id}] disconnected: {exc}. Reconnecting in 2s...")
            time.sleep(2)


if __name__ == "__main__":
    main()
