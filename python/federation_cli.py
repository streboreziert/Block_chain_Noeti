#!/usr/bin/env python3
"""Federation CLI — register this hub with peer validators."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "connection-layer"))

from federation_auto import bootstrap_federation, import_peer_validator, register_self_with_peer, unify_federation_chains  # noqa: E402
from validators import hub_validator_wallet, known_validators, validator_info  # noqa: E402


def cmd_info(_: argparse.Namespace) -> None:
    info = validator_info()
    peers = [v.to_dict() for v in known_validators().values()]
    print(json.dumps({"local": info.to_dict(), "federation": peers}, indent=2))


def cmd_join(args: argparse.Namespace) -> None:
    public = args.public_url or args.peer
    print(json.dumps(register_self_with_peer(args.peer, public), indent=2))
    print(json.dumps(import_peer_validator(args.peer), indent=2))
    print(json.dumps(unify_federation_chains(public), indent=2))


def cmd_sync_chains(args: argparse.Namespace) -> None:
    public = args.public_url or os.environ.get("PUBLIC_URL", "").strip()
    if not public:
        raise SystemExit("Set --public-url or PUBLIC_URL for this hub")
    print(json.dumps(unify_federation_chains(public), indent=2))


def cmd_bootstrap(args: argparse.Namespace) -> None:
    public = args.public_url or "http://127.0.0.1:5052"
    print(json.dumps(bootstrap_federation(public), indent=2))


def _hub_get(hub: str, path: str) -> dict:
    import urllib.request

    with urllib.request.urlopen(f"{hub.rstrip('/')}{path}", timeout=15.0) as response:
        return json.loads(response.read().decode("utf-8"))


def _hub_post(hub: str, path: str, body: dict) -> dict:
    import urllib.request

    request = urllib.request.Request(
        f"{hub.rstrip('/')}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30.0) as response:
        return json.loads(response.read().decode("utf-8"))


def cmd_register_onchain(args: argparse.Namespace) -> None:
    """Stake VALIDATOR_MIN_STAKE and record this validator on-chain."""
    import time as _time

    from chain_state import VALIDATOR_MIN_STAKE

    wallet = hub_validator_wallet()
    hub = args.hub.rstrip("/")
    public = args.public_url or hub

    row = _hub_get(hub, f"/api/wallet/balance?address={wallet.address}")
    balance, staked, nonce = row.get("balance", 0.0), row.get("staked", 0.0), int(row.get("nonce", 0))
    print(f"validator wallet {wallet.address}: balance={balance} staked={staked}")

    if staked < VALIDATOR_MIN_STAKE:
        needed = round(VALIDATOR_MIN_STAKE - staked, 6)
        if balance < needed:
            raise SystemExit(
                f"Need {needed} MLC to stake (balance {balance}). Fund the validator wallet first:\n"
                f"  python3 treasury_cli.py transfer --to {wallet.address} --amount {needed}"
            )
        stake = wallet.sign_transaction(
            {
                "type": "stake",
                "from": wallet.address,
                "amount": needed,
                "node_id": f"validator:{wallet.name}",
                "nonce": nonce,
                "timestamp": _time.time(),
            }
        )
        print(json.dumps({"stake": _hub_post(hub, "/api/transfer", stake)}, indent=2))
        nonce += 1

    register = wallet.sign_transaction(
        {
            "type": "validator_register",
            "from": wallet.address,
            "amount": 0,
            "validator_id": wallet.name,
            "hub_url": public,
            "nonce": nonce,
            "timestamp": _time.time(),
        }
    )
    print(json.dumps({"validator_register": _hub_post(hub, "/api/transfer", register)}, indent=2))


def cmd_pair(args: argparse.Namespace) -> None:
    """Register this hub with a peer and import the peer validator."""
    public = args.public_url or os.environ.get("PUBLIC_URL", "").strip()
    if not public:
        raise SystemExit("Set --public-url or PUBLIC_URL for this hub")
    print(json.dumps(register_self_with_peer(args.peer, public), indent=2))
    print(json.dumps(import_peer_validator(args.peer), indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Noetis federation")
    sub = parser.add_subparsers(dest="command", required=True)

    info = sub.add_parser("info", help="Show local validator and federation")
    info.set_defaults(func=cmd_info)

    join = sub.add_parser("join", help="Register with a peer hub")
    join.add_argument("--peer", required=True, help="Peer hub URL")
    join.add_argument("--public-url", default="", help="This hub's public URL")
    join.set_defaults(func=cmd_join)

    pair = sub.add_parser("pair", help="Join one peer (alias for join)")
    pair.add_argument("--peer", required=True, help="Peer hub URL")
    pair.add_argument("--public-url", default="", help="This hub's public URL")
    pair.set_defaults(func=cmd_pair)

    sync = sub.add_parser("sync-chains", help="Unify chain with federation peers")
    sync.add_argument("--public-url", default="", help="This hub's public URL")
    sync.set_defaults(func=cmd_sync_chains)

    boot = sub.add_parser("bootstrap", help="Bootstrap from FEDERATION_PEERS env")
    boot.add_argument("--public-url", default="https://noeticompute.com")
    boot.set_defaults(func=cmd_bootstrap)

    onchain = sub.add_parser("register-onchain", help="Stake and record this validator on-chain")
    onchain.add_argument("--hub", default="http://127.0.0.1:5052", help="Hub API to submit through")
    onchain.add_argument("--public-url", default="", help="This hub's public URL")
    onchain.set_defaults(func=cmd_register_onchain)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
