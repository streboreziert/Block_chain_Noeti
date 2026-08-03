#!/usr/bin/env python3
"""P2P chain sync — full or light client modes + gossip mesh."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "connection-layer"))

from gossip_mesh import get_mesh, start_mesh_with_federation  # noqa: E402
from p2p_sync import ChainSyncer  # noqa: E402
from resolve_hub import resolve_hub  # noqa: E402
from validators import known_validators  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Noetis P2P chain sync node")
    parser.add_argument("--hub", default="", help="Entry/hub URL (auto-discover if empty)")
    parser.add_argument("--interval", type=float, default=30.0, help="Sync interval seconds")
    parser.add_argument("--light", action="store_true", help="Light client — headers + selective blocks")
    parser.add_argument("--mesh", action="store_true", help="Enable TCP gossip mesh")
    parser.add_argument("--once", action="store_true", help="Sync once and exit")
    args = parser.parse_args()

    hub = resolve_hub(args.hub)
    syncer = ChainSyncer(hub, light=args.light)

    if args.mesh:
        peer_urls = [v.hub_url for v in known_validators().values() if v.hub_url]
        peer_urls.append(hub)
        start_mesh_with_federation(peer_urls)

    mode = "light" if args.light else "full"
    print("Chain sync node")
    print(f"Hub:      {hub}")
    print(f"Mode:     {mode}")
    print(f"Interval: {args.interval}s")
    if args.mesh:
        print(f"Mesh:     port {get_mesh().snapshot()['mesh_port']}")
    print("")

    if args.once:
        result = syncer.sync_once()
        print(result)
        sys.exit(0 if result.get("ok") else 1)

    result = syncer.sync_once()
    print(f"[sync] {result}")

    syncer.start_background(args.interval)
    try:
        while True:
            time.sleep(args.interval)
            snap = syncer.snapshot()
            mesh = get_mesh().snapshot() if args.mesh else {}
            print(
                f"[sync] mode={snap['mode']} length={snap['local_length']} "
                f"peers={len(mesh.get('peers', []))} error={snap.get('last_error') or 'none'}"
            )
    except KeyboardInterrupt:
        print("\nSync node stopped.")
        syncer.stop()


if __name__ == "__main__":
    main()
