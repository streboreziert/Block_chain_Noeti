#!/usr/bin/env python3
"""Client — submit a prompt to the decentralized inference coordinator."""

from __future__ import annotations

import argparse
import json
import socket
import sys

from utils.protocol import read_message, send_message

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9600


def submit_prompt(host: str, port: int, text: str) -> dict:
    with socket.create_connection((host, port), timeout=300) as conn:
        send_message(conn, {"op": "prompt", "role": "client", "text": text})
        message, _ = read_message(conn)

        if message.get("op") == "error":
            raise RuntimeError(message.get("message", "Unknown error"))

        if message.get("op") != "task_complete":
            raise RuntimeError(f"Unexpected response: {message}")

        return message


def main() -> None:
    parser = argparse.ArgumentParser(description="Submit a prompt to the inference network")
    parser.add_argument("prompt", nargs="?", help="Prompt text")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--json", action="store_true", help="Print raw JSON response")
    args = parser.parse_args()

    prompt = args.prompt
    if not prompt:
        prompt = sys.stdin.read().strip()
    if not prompt:
        print("Usage: python client.py \"Your prompt here\"")
        sys.exit(1)

    print(f"[client] sending prompt to {args.host}:{args.port}")
    result = submit_prompt(args.host, args.port, prompt)

    if args.json:
        print(json.dumps(result, indent=2))
        return

    print("\n" + "=" * 72)
    print("DECENTRALIZED INFERENCE RESULT")
    print("=" * 72)
    print(f"Task ID:   {result.get('task_id')}")
    print(f"Prompt:    {result.get('prompt')}")
    print(f"Consensus: {result.get('consensus_response')}")
    print("-" * 72)
    for row in result.get("results", []):
        print(
            f"{row['worker_id']:<10} "
            f"{row['inference_ms']:>8.1f}ms "
            f"reward={row['reward']:.4f} "
            f"{'OK' if row['matched_consensus'] else 'DIFF'}"
        )
    print("=" * 72)


if __name__ == "__main__":
    main()
