#!/usr/bin/env python3
"""Create and use Ed25519 MLC wallets — stake, transfer, sign transactions."""

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

from chain_state import MIN_STAKE  # noqa: E402
from crypto_wallet import get_or_create_wallet, load_wallet, save_wallet, create_wallet  # noqa: E402


def api_call(hub: str, method: str, path: str, body: dict | None = None) -> dict:
    url = f"{hub.rstrip('/')}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def cmd_create(args: argparse.Namespace) -> None:
    name = args.name or "default"
    if load_wallet(name):
        print(f"Wallet '{name}' already exists.")
        wallet = load_wallet(name)
    else:
        wallet = create_wallet(name)
        save_wallet(wallet)
    print(f"Wallet:  {wallet.name}")
    print(f"Address: {wallet.address}")
    print(f"Saved:   connection-layer/data/wallets/{wallet.name}.json")


def cmd_show(args: argparse.Namespace) -> None:
    wallet = load_wallet(args.name or "default")
    if not wallet:
        print("No wallet found. Run: python3 wallet_cli.py create")
        sys.exit(1)
    print(json.dumps(wallet.to_public_dict(), indent=2))
    if args.hub:
        try:
            balance = api_call(args.hub, "GET", f"/api/wallet/balance?address={wallet.address}")
            print(json.dumps(balance, indent=2))
        except Exception as exc:
            print(f"Could not fetch balance: {exc}")


def cmd_stake(args: argparse.Namespace) -> None:
    wallet = get_or_create_wallet(args.name or "default")
    amount = float(args.amount or MIN_STAKE)
    tx = wallet.sign_transaction(
        {
            "type": "stake",
            "from": wallet.address,
            "amount": amount,
            "node_id": args.node_id,
            "nonce": int(args.nonce or 0),
            "timestamp": time.time(),
        }
    )
    if args.hub:
        result = api_call(args.hub, "POST", "/api/transfer", tx)
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(tx, indent=2))


def cmd_transfer(args: argparse.Namespace) -> None:
    wallet = get_or_create_wallet(args.name or "default")
    tx = wallet.sign_transaction(
        {
            "type": "transfer",
            "from": wallet.address,
            "to": args.to,
            "amount": float(args.amount),
            "nonce": int(args.nonce or 0),
            "timestamp": time.time(),
        }
    )
    if not args.hub:
        print(json.dumps(tx, indent=2))
        return
    result = api_call(args.hub, "POST", "/api/transfer", tx)
    print(json.dumps(result, indent=2))


def cmd_faucet(args: argparse.Namespace) -> None:
    wallet = get_or_create_wallet(args.name or "default")
    result = api_call(
        args.hub,
        "POST",
        "/api/faucet",
        {"address": wallet.address, "amount": float(args.amount or 100)},
    )
    print(json.dumps(result, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Noetis MLC wallet (Ed25519)")
    parser.add_argument("--name", default="default", help="Wallet name")
    parser.add_argument("--hub", default="http://127.0.0.1:5052", help="Hub URL")
    sub = parser.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create", help="Create a new wallet")
    create.set_defaults(func=cmd_create)

    show = sub.add_parser("show", help="Show wallet address and balance")
    show.set_defaults(func=cmd_show)

    stake = sub.add_parser("stake", help="Stake MLC for compute node")
    stake.add_argument("--node-id", required=True)
    stake.add_argument("--amount", default=str(MIN_STAKE))
    stake.add_argument("--nonce", default="0")
    stake.set_defaults(func=cmd_stake)

    transfer = sub.add_parser("transfer", help="Signed MLC transfer")
    transfer.add_argument("--to", required=True)
    transfer.add_argument("--amount", required=True)
    transfer.add_argument("--nonce", default="0")
    transfer.set_defaults(func=cmd_transfer)

    faucet = sub.add_parser("faucet", help="Request dev faucet credits (ALLOW_FAUCET=1 on hub)")
    faucet.add_argument("--amount", default="100")
    faucet.set_defaults(func=cmd_faucet)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
