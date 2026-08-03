#!/usr/bin/env python3
"""Treasury operations — distribute MLC for mainnet onboarding."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "connection-layer"))

from inference_chain import get_chain  # noqa: E402
from treasury import distribute_from_treasury, grant_onboarding_credit, treasury_wallet  # noqa: E402


def cmd_info(_: argparse.Namespace) -> None:
    wallet = treasury_wallet()
    state = get_chain().current_state()
    row = state.get(wallet.address, {"balance": 0, "staked": 0, "nonce": 0})
    print(json.dumps({"treasury_address": wallet.address, **row}, indent=2))


def cmd_faucet(args: argparse.Namespace) -> None:
    result = grant_onboarding_credit(args.address, float(args.amount) if args.amount else None)
    print(json.dumps(result, indent=2))


def cmd_send(args: argparse.Namespace) -> None:
    wallet = treasury_wallet()
    state = get_chain().current_state()
    nonce = int(state.get(wallet.address, {}).get("nonce", 0))
    result = distribute_from_treasury(args.to, float(args.amount), nonce=nonce)
    print(json.dumps(result, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Noetis treasury CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    info = sub.add_parser("info", help="Show treasury address and balance")
    info.set_defaults(func=cmd_info)

    faucet = sub.add_parser("faucet", help="Grant rate-limited onboarding credit")
    faucet.add_argument("--address", required=True)
    faucet.add_argument("--amount", default="")
    faucet.set_defaults(func=cmd_faucet)

    send = sub.add_parser("send", help="Signed transfer from treasury")
    send.add_argument("--to", required=True)
    send.add_argument("--amount", required=True, type=float)
    send.set_defaults(func=cmd_send)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
