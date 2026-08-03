"""On-chain MLC account state — balances, stakes, and transaction validation."""

from __future__ import annotations

import hashlib
import json
import threading
import time
from copy import deepcopy
from typing import Any

from crypto_wallet import verify_signature

TOKEN_SYMBOL = "MLC"
MIN_STAKE = 10.0
VALIDATOR_MIN_STAKE = 100.0
SLASH_AMOUNT = 1.0
SIGNED_TYPES = {"transfer", "stake", "unstake", "validator_register"}
SYSTEM_TYPES = {"credit", "slash"}

_lock = threading.Lock()
_mempool: list[dict[str, Any]] = []


def empty_state() -> dict[str, dict[str, Any]]:
    return {}


def account(state: dict[str, dict[str, Any]], address: str) -> dict[str, Any]:
    row = state.setdefault(
        address,
        {"balance": 0.0, "nonce": 0, "staked": 0.0, "node_id": None},
    )
    return row


def state_root(state: dict[str, dict[str, Any]]) -> str:
    from spv import merkle_root_from_state

    return merkle_root_from_state(state)


def validate_transaction(tx: dict[str, Any], state: dict[str, dict[str, Any]]) -> str | None:
    tx_type = str(tx.get("type", ""))
    amount = round(float(tx.get("amount", 0)), 6)
    if tx_type not in SIGNED_TYPES | SYSTEM_TYPES:
        return f"Unknown transaction type: {tx_type}"

    if tx_type in SIGNED_TYPES:
        if not verify_signature(tx):
            return "Invalid signature"
        sender = account(state, str(tx["from"]))
        nonce = int(tx.get("nonce", -1))
        if nonce != sender["nonce"]:
            return f"Invalid nonce — expected {sender['nonce']}, got {nonce}"
        if amount <= 0 and tx_type != "validator_register":
            return "Amount must be positive"

    if tx_type == "transfer":
        sender = account(state, str(tx["from"]))
        if sender["balance"] < amount:
            return "Insufficient balance"
        if str(tx.get("to", "")) == str(tx["from"]):
            return "Cannot transfer to self"

    if tx_type == "stake":
        sender = account(state, str(tx["from"]))
        if sender["balance"] < amount:
            return "Insufficient balance to stake"
        if amount < MIN_STAKE:
            return f"Minimum stake is {MIN_STAKE} MLC"
        node_id = str(tx.get("node_id", "")).strip()
        if not node_id:
            return "node_id required for stake"

    if tx_type == "unstake":
        sender = account(state, str(tx["from"]))
        if sender["staked"] < amount:
            return "Insufficient staked balance"

    if tx_type == "credit":
        if amount <= 0:
            return "Credit amount must be positive"
        if not str(tx.get("to", "")).strip():
            return "Credit requires recipient"

    if tx_type == "slash":
        if amount <= 0:
            return "Slash amount must be positive"
        if not str(tx.get("from", "")).strip():
            return "Slash requires source address"

    if tx_type == "validator_register":
        sender = account(state, str(tx["from"]))
        if not str(tx.get("validator_id", "")).strip():
            return "validator_id required"
        if not str(tx.get("hub_url", "")).strip():
            return "hub_url required"
        if sender["staked"] < VALIDATOR_MIN_STAKE:
            return f"Validators must stake at least {VALIDATOR_MIN_STAKE} MLC (staked: {sender['staked']})"

    return None


def apply_transaction(state: dict[str, dict[str, Any]], tx: dict[str, Any]) -> None:
    tx_type = str(tx["type"])
    amount = round(float(tx["amount"]), 6)

    if tx_type == "credit":
        recipient = account(state, str(tx["to"]))
        recipient["balance"] = round(recipient["balance"] + amount, 6)
        return

    if tx_type == "transfer":
        sender = account(state, str(tx["from"]))
        recipient = account(state, str(tx["to"]))
        sender["balance"] = round(sender["balance"] - amount, 6)
        sender["nonce"] = int(sender["nonce"]) + 1
        recipient["balance"] = round(recipient["balance"] + amount, 6)
        return

    if tx_type == "stake":
        sender = account(state, str(tx["from"]))
        sender["balance"] = round(sender["balance"] - amount, 6)
        sender["staked"] = round(sender["staked"] + amount, 6)
        sender["node_id"] = str(tx["node_id"])
        sender["nonce"] = int(sender["nonce"]) + 1
        return

    if tx_type == "unstake":
        sender = account(state, str(tx["from"]))
        sender["staked"] = round(sender["staked"] - amount, 6)
        sender["balance"] = round(sender["balance"] + amount, 6)
        if sender["staked"] <= 0:
            sender["node_id"] = None
        sender["nonce"] = int(sender["nonce"]) + 1
        return

    if tx_type == "slash":
        source = account(state, str(tx["from"]))
        remaining = amount
        from_staked = min(source["staked"], remaining)
        source["staked"] = round(source["staked"] - from_staked, 6)
        remaining = round(remaining - from_staked, 6)
        if remaining > 0:
            from_balance = min(source["balance"], remaining)
            source["balance"] = round(source["balance"] - from_balance, 6)
        if source["staked"] < MIN_STAKE:
            source["node_id"] = None
        return

    if tx_type == "validator_register":
        sender = account(state, str(tx["from"]))
        sender["validator"] = {
            "validator_id": str(tx["validator_id"]),
            "public_key": str(tx.get("public_key", "")),
            "hub_url": str(tx["hub_url"]),
            "registered_at": float(tx.get("timestamp", time.time())),
        }
        sender["nonce"] = int(sender["nonce"]) + 1


def apply_transactions(
    state: dict[str, dict[str, Any]], transactions: list[dict[str, Any]]
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    next_state = deepcopy(state)
    errors: list[str] = []
    for tx in transactions:
        error = validate_transaction(tx, next_state)
        if error:
            errors.append(error)
            continue
        apply_transaction(next_state, tx)
    return next_state, errors


def rebuild_state_from_chain(blocks: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    state = empty_state()
    for block in blocks:
        proof = block.get("proof") or {}
        transactions = proof.get("transactions") or []
        state, _ = apply_transactions(state, transactions)
    return state


def credit_tx(
    *,
    to_address: str,
    amount: float,
    reason: str,
    worker_id: str = "",
    task_id: str = "",
) -> dict[str, Any]:
    return {
        "type": "credit",
        "to": to_address,
        "amount": round(amount, 6),
        "reason": reason,
        "worker_id": worker_id,
        "task_id": task_id,
        "timestamp": time.time(),
    }


def slash_tx(
    *,
    from_address: str,
    amount: float,
    node_id: str,
    reason: str,
    task_id: str = "",
) -> dict[str, Any]:
    return {
        "type": "slash",
        "from": from_address,
        "amount": round(amount, 6),
        "node_id": node_id,
        "reason": reason,
        "task_id": task_id,
        "timestamp": time.time(),
    }


def add_to_mempool(tx: dict[str, Any]) -> tuple[bool, str]:
    with _lock:
        for pending in _mempool:
            if pending.get("from") == tx.get("from") and pending.get("nonce") == tx.get("nonce"):
                return False, "Duplicate transaction in mempool"
        _mempool.append(tx)
    return True, "accepted"


def drain_mempool(limit: int = 50) -> list[dict[str, Any]]:
    with _lock:
        batch = list(_mempool[:limit])
        _mempool[:] = _mempool[len(batch) :]
    return batch


def mempool_snapshot() -> list[dict[str, Any]]:
    with _lock:
        return list(_mempool)


def get_balance(state: dict[str, dict[str, Any]], address: str) -> dict[str, Any]:
    row = account(state, address)
    return {
        "address": address,
        "balance": round(row["balance"], 6),
        "staked": round(row["staked"], 6),
        "nonce": row["nonce"],
        "node_id": row.get("node_id"),
        "total": round(row["balance"] + row["staked"], 6),
    }


def list_balances(state: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows = [get_balance(state, address) for address in state]
    rows.sort(key=lambda item: item["total"], reverse=True)
    return rows


def has_minimum_stake(state: dict[str, dict[str, Any]], address: str, node_id: str) -> bool:
    row = account(state, address)
    return row["staked"] >= MIN_STAKE and row.get("node_id") == node_id


def on_chain_validators(state: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Validators registered on-chain (validator_register tx with stake still locked)."""
    rows: list[dict[str, Any]] = []
    for address, row in state.items():
        info = row.get("validator")
        if not info:
            continue
        if row.get("staked", 0.0) < VALIDATOR_MIN_STAKE:
            continue  # stake withdrawn or slashed below threshold — no longer a validator
        rows.append({**info, "address": address, "staked": row["staked"]})
    return rows
