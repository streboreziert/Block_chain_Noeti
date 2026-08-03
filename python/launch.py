#!/usr/bin/env python3
"""Noetis launcher — host network, join as user, or join as compute."""

from __future__ import annotations

import argparse
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _resolved_hub(args: argparse.Namespace) -> str:
    from resolve_hub import resolve_hub

    return resolve_hub(args.hub)


def run_hub(args: argparse.Namespace) -> None:
    cmd = [
        sys.executable,
        str(ROOT / "app.py"),
        "--role",
        "entry" if args.role == "entry" else "hub",
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--model",
        args.model,
    ]
    if getattr(args, "public_url", ""):
        cmd.extend(["--public-url", args.public_url])
    if args.open:
        cmd.append("--open")
    subprocess.run(cmd, cwd=str(ROOT))


def run_user(args: argparse.Namespace) -> None:
    hub = _resolved_hub(args)
    port = getattr(args, "app_port", 5056)
    cmd = [
        sys.executable,
        str(ROOT / "user_app.py"),
        "--hub",
        hub,
        "--port",
        str(port),
    ]
    if args.open:
        cmd.append("--open")
    print(f"Network entry: {hub}")
    print(f"Standalone app: http://127.0.0.1:{port}")
    print("Wallet + terminal run locally — hub website is discovery only.\n")
    subprocess.run(cmd, cwd=str(ROOT))


def run_relay(args: argparse.Namespace) -> None:
    relay_id = args.id or _default_relay_id()
    hub = _resolved_hub(args)
    print(f"Connecting to entry point: {hub}")
    cmd = [
        sys.executable,
        str(ROOT / "relay.py"),
        "--hub",
        hub,
        "--id",
        relay_id,
    ]
    subprocess.run(cmd, cwd=str(ROOT))


def _default_relay_id() -> str:
    import socket

    host = socket.gethostname().split(".")[0][:12]
    return f"relay-{host}"


def run_compute(args: argparse.Namespace) -> None:
    node_id = args.id or _default_node_id()
    hub = _resolved_hub(args)
    print(f"Connecting to entry point: {hub}")
    cmd = [
        sys.executable,
        str(ROOT / "compute.py"),
        "--hub",
        hub,
        "--id",
        node_id,
        "--model",
        args.model,
    ]
    subprocess.run(cmd, cwd=str(ROOT))


def _default_node_id() -> str:
    import socket

    host = socket.gethostname().split(".")[0][:12]
    return f"compute-{host}"


def run_sync(args: argparse.Namespace) -> None:
    hub = _resolved_hub(args)
    cmd = [
        sys.executable,
        str(ROOT / "sync_node.py"),
        "--hub",
        hub,
        "--interval",
        "30",
    ]
    if getattr(args, "light", False):
        cmd.append("--light")
    subprocess.run(cmd, cwd=str(ROOT))


def run_mesh(args: argparse.Namespace) -> None:
    hub = _resolved_hub(args)
    cmd = [
        sys.executable,
        str(ROOT / "sync_node.py"),
        "--hub",
        hub,
        "--light",
        "--mesh",
        "--interval",
        "20",
    ]
    subprocess.run(cmd, cwd=str(ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description="Noetis network launcher")
    parser.add_argument(
        "role",
        choices=["hub", "entry", "user", "relay", "compute", "sync", "mesh", "discover"],
        help="hub/entry · user · relay · compute · sync · mesh · discover",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Hub bind address (hub role)")
    parser.add_argument("--port", type=int, default=5052, help="Hub port (hub role)")
    parser.add_argument("--app-port", type=int, default=5056, help="Local user app port (user role)")
    parser.add_argument("--hub", default="", help="Entry/hub URL (auto-discover if empty)")
    parser.add_argument("--public-url", default="", help="Public entry URL when hosting")
    parser.add_argument("--id", help="Compute node name (compute role)")
    parser.add_argument("--light", action="store_true", help="Light chain sync (sync role)")
    parser.add_argument("--model", default="qwen2.5:0.5b")
    parser.add_argument("--open", action="store_true", help="Open browser (hub/user)")
    args = parser.parse_args()

    if args.role in ("hub", "entry"):
        run_hub(args)
    elif args.role == "discover":
        from resolve_hub import resolve_hub

        hub = resolve_hub(args.hub)
        print(f"Network entry: {hub}")
        print(f"Discovery:     {hub}/")
        print(f"Local app:     python3 launch.py user --hub {hub} --open")
    elif args.role == "user":
        run_user(args)
    elif args.role == "relay":
        run_relay(args)
    elif args.role == "sync":
        run_sync(args)
    elif args.role == "mesh":
        run_mesh(args)
    else:
        run_compute(args)


if __name__ == "__main__":
    main()
