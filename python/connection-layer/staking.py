"""Staking and slashing for compute Sybil resistance."""

from __future__ import annotations

from typing import Any

from chain_state import MIN_STAKE, SLASH_AMOUNT, get_balance, has_minimum_stake, slash_tx


def stake_requirements(state: dict[str, dict[str, Any]], address: str, node_id: str) -> dict[str, Any]:
    row = get_balance(state, address)
    ok = has_minimum_stake(state, address, node_id)
    return {
        "address": address,
        "node_id": node_id,
        "min_stake": MIN_STAKE,
        "staked": row["staked"],
        "eligible": ok,
        "message": "Stake locked — eligible for compute tasks"
        if ok
        else f"Stake at least {MIN_STAKE} MLC for node {node_id}",
    }


def slash_outliers(
    *,
    state: dict[str, dict[str, Any]],
    results: list[Any],
    wallet_by_worker: dict[str, str],
    task_id: str,
) -> list[dict[str, Any]]:
    txs: list[dict[str, Any]] = []
    for item in results:
        if item.matched_consensus:
            continue
        address = wallet_by_worker.get(item.worker_id)
        if not address:
            continue
        row = get_balance(state, address)
        if row["staked"] + row["balance"] <= 0:
            continue
        txs.append(
            slash_tx(
                from_address=address,
                amount=SLASH_AMOUNT,
                node_id=item.worker_id,
                reason="Consensus outlier — response did not match majority",
                task_id=task_id,
            )
        )
    return txs
