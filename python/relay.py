#!/usr/bin/env python3
"""Join the Noetis network as a relay — route user prompts to compute anonymously."""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "connection-layer"))

from net_utils import get_lan_ip  # noqa: E402

DEFAULT_HUB = "http://127.0.0.1:5052"
POLL_INTERVAL = 0.8


def api_call(hub: str, method: str, path: str, body: dict | None = None) -> dict:
    url = f"{hub.rstrip('/')}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Hub error {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Cannot reach hub at {hub}") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description="Join Noetis network as relay")
    parser.add_argument("--hub", default=DEFAULT_HUB, help="Network hub URL")
    parser.add_argument("--id", dest="relay_id", required=True, help="Your relay node name")
    parser.add_argument("--access-url", default="", help="Public access URL for this relay (shown on entry.txt)")
    args = parser.parse_args()

    access_url = args.access_url.strip() or f"relay://{get_lan_ip()}"

    print(f"Relay node:  {args.relay_id}")
    print(f"Hub:         {args.hub}")
    print("Role:        route user prompts to compute — user identity stays hidden")
    print("Waiting for tasks to relay… (Ctrl+C to stop)\n", flush=True)

    api_call(
        args.hub,
        "POST",
        "/api/relay/register",
        {"relay_id": args.relay_id, "access_url": access_url},
    )

    while True:
        try:
            api_call(args.hub, "POST", "/api/relay/heartbeat", {"relay_id": args.relay_id})
            task = api_call(args.hub, "GET", f"/api/relay/poll?relay_id={args.relay_id}")
            if task and task.get("task_id"):
                task_id = task["task_id"]
                print(f"[relay] {task_id}: forwarding anonymous task to compute pool")
                api_call(
                    args.hub,
                    "POST",
                    "/api/relay/forward",
                    {"relay_id": args.relay_id, "task_id": task_id},
                )
                print(f"[relay] {task_id}: forwarded — compute never sees user")
        except KeyboardInterrupt:
            print("\nRelay stopped.")
            break
        except Exception as exc:
            print(f"[warn] {exc}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
