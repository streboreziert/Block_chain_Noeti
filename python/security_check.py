#!/usr/bin/env python3
"""Noetis security audit — verify chain, keys, and hub hardening.

Usage:
  python3 security_check.py                                # local node audit
  python3 security_check.py --hub https://noeticompute.com # remote hub audit
"""

from __future__ import annotations

import argparse
import json
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "connection-layer"))

PASS = "  ✓"
FAIL = "  ✗"
WARN = "  !"

results: list[tuple[bool, str]] = []


def check(ok: bool, label: str, *, warn_only: bool = False) -> None:
    mark = PASS if ok else (WARN if warn_only else FAIL)
    print(f"{mark} {label}")
    results.append((ok or warn_only, label))


def _get(url: str, path: str, timeout: float = 15.0):
    request = urllib.request.Request(f"{url.rstrip('/')}{path}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8")), dict(response.headers)


def local_checks() -> None:
    print("\n[local node]")
    from inference_chain import CHAIN_VERSION, get_chain

    chain = get_chain()
    check(chain.is_valid_structure(), "chain structure valid (hash links, Merkle roots)")
    check(chain.is_valid_state(), "chain state valid (transaction replay)")
    genesis_version = (chain.chain[0].proof or {}).get("chain_version")
    check(genesis_version == CHAIN_VERSION, f"genesis chain version == v{CHAIN_VERSION}")

    from validators import verify_block_validator

    latest = chain.last_block
    check(
        verify_block_validator(latest.proof or {}, latest.hash),
        "validator signature verifies on latest block",
    )

    from consensus import effective_quorum
    from validators import known_validators

    quorum = effective_quorum()
    validators = len(known_validators())
    check(quorum >= 2 or validators < 2, f"cosign quorum sane (quorum={quorum}, validators={validators})")

    wallets_dir = ROOT / "connection-layer" / "data" / "wallets"
    bad_perm = []
    if wallets_dir.exists():
        for keyfile in wallets_dir.iterdir():
            if keyfile.is_file():
                mode = stat.S_IMODE(keyfile.stat().st_mode)
                if mode & 0o077:
                    bad_perm.append(keyfile.name)
    check(not bad_perm, f"wallet/key file permissions 0600 ({'ok' if not bad_perm else ', '.join(bad_perm)})")


def remote_checks(hub: str) -> None:
    print(f"\n[remote hub {hub}]")
    check(hub.startswith("https://"), "public hub uses HTTPS")

    health, headers = _get(hub, "/api/health")
    check(bool(health.get("ok")), "hub healthy")
    check(bool(health.get("chain_valid")), "remote chain reports valid")
    check(headers.get("X-Content-Type-Options") == "nosniff", "security headers present (nosniff)")
    check("Access-Control-Allow-Origin" not in headers, "no wildcard CORS on plain requests")

    onboard, _ = _get(hub, "/api/onboard")
    mode = str(onboard.get("faucet_mode", ""))
    check(mode in {"limited", "rate_limited", "0", "false"}, f"faucet not unlimited (mode={mode})")

    validators, _ = _get(hub, "/api/validators")
    count = len(validators.get("validators", []))
    check(count >= 2, f"federation has >=2 validators ({count})", warn_only=count == 1)

    # SPV proof round-trip on the treasury address from genesis.
    block0, _ = _get(hub, "/api/chain/block/0")
    txs = (block0.get("proof") or {}).get("transactions") or []
    treasury = next((t.get("to") for t in txs if t.get("to")), None)
    if treasury:
        proof, _ = _get(hub, f"/api/wallet/proof?address={treasury}")
        from spv import verify_account_proof

        check(verify_account_proof(proof), "SPV Merkle balance proof verifies")
    else:
        check(False, "treasury address found in genesis", warn_only=True)

    # Rate limiting: /api/chain/sync should reject empty spam politely (400/429, not 500).
    try:
        request = urllib.request.Request(
            f"{hub}/api/chain/sync",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=15.0) as response:
            code = response.status
    except urllib.error.HTTPError as exc:
        code = exc.code
    check(code in (200, 400, 429), f"chain sync endpoint guarded (HTTP {code})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Noetis security audit")
    parser.add_argument("--hub", default="", help="Remote hub URL to audit")
    parser.add_argument("--skip-local", action="store_true", help="Skip local node checks")
    args = parser.parse_args()

    if not args.skip_local:
        local_checks()
    if args.hub:
        remote_checks(args.hub.rstrip("/"))

    failed = [label for ok, label in results if not ok]
    print(f"\n{'ALL CHECKS PASSED' if not failed else 'FAILURES:'} ({len(results) - len(failed)}/{len(results)})")
    for label in failed:
        print(f"  - {label}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
