"""SPV account proofs — verify balances against state_root without full chain."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def account_row(address: str, row: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "address": address,
        "balance": round(row.get("balance", 0.0), 6),
        "nonce": int(row.get("nonce", 0)),
        "staked": round(row.get("staked", 0.0), 6),
        "node_id": row.get("node_id"),
    }
    # Only included when set, so pre-existing state roots stay valid.
    if row.get("validator"):
        payload["validator"] = row["validator"]
    return payload


def leaf_hash(address: str, row: dict[str, Any]) -> str:
    payload = account_row(address, row)
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _merkle_layer(hashes: list[str]) -> list[str]:
    if not hashes:
        return [hashlib.sha256(b"").hexdigest()]
    if len(hashes) == 1:
        return hashes
    layer: list[str] = []
    for index in range(0, len(hashes), 2):
        left = hashes[index]
        right = hashes[index + 1] if index + 1 < len(hashes) else left
        layer.append(hashlib.sha256((left + right).encode()).hexdigest())
    return layer


def merkle_root_from_state(state: dict[str, dict[str, Any]]) -> str:
    if not state:
        return hashlib.sha256(b"").hexdigest()
    leaves = [leaf_hash(address, state[address]) for address in sorted(state)]
    layer = leaves
    while len(layer) > 1:
        layer = _merkle_layer(layer)
    return layer[0]


def build_merkle_tree(state: dict[str, dict[str, Any]]) -> tuple[list[str], list[list[str]]]:
    """Return sorted leaves and levels (levels[0] = leaves, levels[-1] = root)."""
    leaves = [leaf_hash(address, state[address]) for address in sorted(state)]
    if not leaves:
        return [], [[hashlib.sha256(b"").hexdigest()]]
    levels: list[list[str]] = [leaves]
    layer = leaves
    while len(layer) > 1:
        layer = _merkle_layer(layer)
        levels.append(layer)
    return leaves, levels


def account_proof(state: dict[str, dict[str, Any]], address: str) -> dict[str, Any] | None:
    if address not in state:
        return None
    leaves, levels = build_merkle_tree(state)
    sorted_addresses = sorted(state)
    try:
        index = sorted_addresses.index(address)
    except ValueError:
        return None
    siblings: list[dict[str, str]] = []
    pos = index
    for level in levels[:-1]:
        pair_index = pos ^ 1
        if pair_index < len(level):
            siblings.append({"hash": level[pair_index], "position": "right" if pos % 2 == 0 else "left"})
        else:
            siblings.append({"hash": level[pos], "position": "right"})
        pos //= 2
    return {
        "address": address,
        "account": account_row(address, state[address]),
        "leaf": leaves[index],
        "siblings": siblings,
        "state_root": levels[-1][0],
    }


def verify_account_proof(proof: dict[str, Any]) -> bool:
    row = proof.get("account") or {}
    address = str(proof.get("address", ""))
    expected_leaf = leaf_hash(address, row)
    if proof.get("leaf") != expected_leaf:
        return False
    current = expected_leaf
    for step in proof.get("siblings") or []:
        sibling = str(step.get("hash", ""))
        if step.get("position") == "left":
            current = hashlib.sha256((sibling + current).encode()).hexdigest()
        else:
            current = hashlib.sha256((current + sibling).encode()).hexdigest()
    return current == proof.get("state_root")
