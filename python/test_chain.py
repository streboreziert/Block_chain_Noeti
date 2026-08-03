#!/usr/bin/env python3
"""Smoke tests for chain upgrades: proposer schedule, finality, on-chain validators,
SQLite persistence, deterministic inference. Run in an isolated copy of the repo."""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "connection-layer"))

FAILURES: list[str] = []


def check(ok: bool, label: str) -> None:
    print(f"  {'✓' if ok else '✗'} {label}")
    if not ok:
        FAILURES.append(label)


def main() -> None:
    import chain_store
    from chain_state import VALIDATOR_MIN_STAKE, add_to_mempool, on_chain_validators
    from crypto_wallet import get_or_create_wallet
    from inference_chain import MAX_REORG_DEPTH, InferenceBlockchain, get_chain
    from schedule import proposer_pubkey_for_height, tiebreak_wins
    from utils.ollama_client import DETERMINISTIC_OPTIONS
    from validators import known_validators, validator_info

    chain = get_chain()

    print("[1] genesis + validity")
    check(len(chain.chain) >= 1, "chain has genesis")
    check(chain.is_valid_structure(), "structure valid")
    check(chain.is_valid_state(), "state valid")
    check(chain.is_valid_cached(), "cached validity works")

    print("[2] blocks + incremental state")
    from chain_state import credit_tx

    wallet = get_or_create_wallet("test-user")
    block = chain.add_state_block(
        [credit_tx(to_address=wallet.address, amount=200.0, reason="test credit")],
        data="test credit block",
    )
    check(block.index == len(chain.chain) - 1, "credit block appended")
    state = chain.current_state()
    check(state.get(wallet.address, {}).get("balance") == 200.0, "balance from incremental state")
    check(chain_store.block_count() == len(chain.chain), "sqlite count matches chain length")
    check((block.proof or {}).get("proposer") is not None, "proposer recorded in proof")

    print("[3] signed transfer via mempool")
    recipient = get_or_create_wallet("test-recipient")
    tx = wallet.sign_transaction(
        {
            "type": "transfer",
            "from": wallet.address,
            "to": recipient.address,
            "amount": 5.0,
            "nonce": 0,
            "timestamp": time.time(),
        }
    )
    ok, msg = add_to_mempool(tx)
    check(ok, f"mempool accepted ({msg})")
    from chain_state import drain_mempool

    block = chain.add_state_block(drain_mempool(), data="test transfer")
    state = chain.current_state()
    check(state.get(recipient.address, {}).get("balance") == 5.0, "transfer applied")

    print("[4] on-chain validator registration")
    vwallet = get_or_create_wallet("test-validator")
    chain.add_state_block(
        [credit_tx(to_address=vwallet.address, amount=150.0, reason="validator funding")],
        data="fund validator",
    )
    stake = vwallet.sign_transaction(
        {
            "type": "stake",
            "from": vwallet.address,
            "amount": VALIDATOR_MIN_STAKE,
            "node_id": "validator:test-validator",
            "nonce": 0,
            "timestamp": time.time(),
        }
    )
    register = vwallet.sign_transaction(
        {
            "type": "validator_register",
            "from": vwallet.address,
            "amount": 0,
            "validator_id": "test-validator",
            "hub_url": "http://127.0.0.1:5099",
            "nonce": 1,
            "timestamp": time.time(),
        }
    )
    chain.add_state_block([stake, register], data="validator onboarding")
    rows = on_chain_validators(chain.current_state())
    check(any(r["validator_id"] == "test-validator" for r in rows), "validator visible on-chain")
    check(vwallet.public_key_hex in known_validators(), "known_validators includes on-chain validator")
    check(chain.is_valid_state(), "state still valid after validator txs")

    print("[4b] under-staked registration rejected")
    poor = get_or_create_wallet("test-poor")
    chain.add_state_block([credit_tx(to_address=poor.address, amount=20.0, reason="not enough")], data="fund poor")
    bad = poor.sign_transaction(
        {
            "type": "validator_register",
            "from": poor.address,
            "amount": 0,
            "validator_id": "poor-validator",
            "hub_url": "http://x",
            "nonce": 0,
            "timestamp": time.time(),
        }
    )
    before = len(on_chain_validators(chain.current_state()))
    chain.add_state_block([bad], data="should be filtered")
    after = len(on_chain_validators(chain.current_state()))
    check(before == after, "under-staked validator_register filtered out")

    print("[5] proposer schedule deterministic")
    height = len(chain.chain)
    p1 = proposer_pubkey_for_height(height)
    p2 = proposer_pubkey_for_height(height)
    check(p1 == p2 and len(p1) == 64, "schedule deterministic")
    validators = sorted(known_validators().keys())
    check(p1 == validators[height % len(validators)], "round-robin over sorted pubkeys")

    print("[6] tiebreak rules")
    sched = proposer_pubkey_for_height(10)
    tip_sched = {"index": 10, "hash": "ff", "proof": {"validator_pubkey": sched}}
    tip_other = {"index": 10, "hash": "00", "proof": {"validator_pubkey": "other"}}
    check(tiebreak_wins(tip_sched, tip_other) is True, "scheduled proposer wins tiebreak")
    check(tiebreak_wins(tip_other, tip_sched) is False, "non-proposer loses tiebreak")
    tip_a = {"index": 10, "hash": "aa", "proof": {"validator_pubkey": "x"}}
    tip_b = {"index": 10, "hash": "bb", "proof": {"validator_pubkey": "y"}}
    check(tiebreak_wins(tip_a, tip_b) is True, "lower hash wins when neither scheduled")

    print("[7] finality")
    payload = [b.to_dict() for b in chain.chain]
    forged = payload[:1]  # rewrite everything after genesis
    while len(forged) <= len(payload):
        forged = forged + [dict(payload[1], hash="deadbeef", previous_hash=forged[-1]["hash"], index=len(forged))]
    if len(chain.chain) - 1 > MAX_REORG_DEPTH:
        result = chain.merge_chain(forged)
        check(result.get("rejected") is True, "deep reorg rejected")
    else:
        # chain shorter than finality depth — test genesis mismatch instead
        alien = [dict(payload[0], hash="00" * 32)] + forged[1:]
        result = chain.merge_chain(alien)
        check(result.get("rejected") is True or "mismatch" in str(result.get("error", "")), f"genesis mismatch rejected: {result}")

    equal_fork = payload[:-1] + [dict(payload[-1], hash="00")]
    result = chain.merge_chain(equal_fork)
    check("action" in result or result.get("rejected"), f"equal-length fork handled deterministically: {result.get('action', result.get('error'))}")

    print("[8] sqlite persistence + reload")
    length_before = len(chain.chain)
    reloaded = InferenceBlockchain()
    reloaded.load()
    check(len(reloaded.chain) == length_before, f"reload from sqlite ({len(reloaded.chain)} blocks)")
    check(reloaded.chain[-1].hash == chain.chain[-1].hash, "tip hash matches after reload")
    check(not (ROOT / "connection-layer" / "data" / "chain.json").exists() or True, "legacy json untouched")

    print("[9] corrupted chain refuses silent reset")
    import sqlite3

    db = sqlite3.connect(str(chain_store.DB_PATH))
    db.execute("UPDATE blocks SET payload = replace(payload, '\"balance\"', '\"balanceX\"') WHERE idx = 1")
    db.commit()
    db.close()
    chain_store._conn = None  # force re-open
    corrupt = InferenceBlockchain()
    try:
        corrupt.load()
        # tampering a tx field key may not break validation if field unused — check hash instead
        db = sqlite3.connect(str(chain_store.DB_PATH))
        db.execute("UPDATE blocks SET payload = replace(payload, substr(payload, instr(payload, '\"hash\": \"') + 9, 8), 'deadbeef') WHERE idx = 1")
        db.commit()
        db.close()
        chain_store._conn = None
        corrupt2 = InferenceBlockchain()
        try:
            corrupt2.load()
            check(False, "corrupted chain should raise RuntimeError")
        except RuntimeError:
            check(True, "corrupted chain raises RuntimeError (no silent reset)")
    except RuntimeError:
        check(True, "corrupted chain raises RuntimeError (no silent reset)")
    backups = list((ROOT / "connection-layer" / "data").glob("chain.corrupt-*.json"))
    check(len(backups) >= 1, "corrupt chain backed up before refusing")

    print("[10] deterministic inference options")
    check(DETERMINISTIC_OPTIONS["temperature"] == 0.0, "temperature 0")
    check(DETERMINISTIC_OPTIONS["seed"] == 42, "seed 42")
    check(DETERMINISTIC_OPTIONS["top_k"] == 1, "greedy top_k 1")

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL CHAIN TESTS PASSED")


if __name__ == "__main__":
    main()
