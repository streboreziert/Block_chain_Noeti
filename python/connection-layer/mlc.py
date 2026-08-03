"""MLC token — on-chain balances derived from the inference blockchain."""

from __future__ import annotations

from typing import Any

from chain_state import list_balances, rebuild_state_from_chain
from inference_chain import get_chain

TOKEN_SYMBOL = "MLC"


def _state() -> dict[str, dict[str, Any]]:
    chain = get_chain()
    return rebuild_state_from_chain([block.to_dict() for block in chain.chain])


def wallet_address(worker_id: str) -> str:
    """Legacy helper — prefer Ed25519 wallet addresses from crypto_wallet."""
    return worker_id


def ensure_wallet(worker_id: str) -> dict[str, Any]:
    state = _state()
    row = state.get(worker_id)
    if row:
        return {
            "address": worker_id,
            "worker_id": worker_id,
            "name": worker_id,
            "balance": row.get("balance", 0.0),
            "staked": row.get("staked", 0.0),
        }
    return {
        "address": worker_id,
        "worker_id": worker_id,
        "name": worker_id,
        "balance": 0.0,
        "staked": 0.0,
    }


def get_balances() -> list[dict[str, Any]]:
    rows = list_balances(_state())
    enriched = []
    for row in rows:
        enriched.append(
            {
                "address": row["address"],
                "worker_id": row.get("node_id") or row["address"],
                "name": row.get("node_id") or row["address"][:16],
                "balance": row["balance"],
                "staked": row["staked"],
                "total": row["total"],
                "blocks_earned": 0,
                "tasks_completed": 0,
            }
        )
    return enriched


def get_ledger(limit: int = 40) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    chain = get_chain()
    for block in reversed(chain.chain):
        proof = block.proof or {}
        for tx in reversed(proof.get("transactions") or []):
            tx_type = tx.get("type")
            if tx_type == "credit":
                entries.append(
                    {
                        "time": tx.get("timestamp", block.timestamp),
                        "address": tx.get("to"),
                        "name": tx.get("worker_id") or tx.get("to"),
                        "amount": tx.get("amount"),
                        "token": TOKEN_SYMBOL,
                        "reason": tx.get("reason", "credit"),
                        "block_index": block.index,
                        "type": tx_type,
                    }
                )
            elif tx_type == "transfer":
                entries.append(
                    {
                        "time": tx.get("timestamp", block.timestamp),
                        "address": tx.get("from"),
                        "name": tx.get("from"),
                        "amount": -float(tx.get("amount", 0)),
                        "token": TOKEN_SYMBOL,
                        "reason": f"Transfer to {tx.get('to')}",
                        "block_index": block.index,
                        "type": tx_type,
                    }
                )
            elif tx_type in {"stake", "slash", "unstake"}:
                entries.append(
                    {
                        "time": tx.get("timestamp", block.timestamp),
                        "address": tx.get("from"),
                        "name": tx.get("node_id") or tx.get("from"),
                        "amount": tx.get("amount"),
                        "token": TOKEN_SYMBOL,
                        "reason": tx.get("reason") or tx_type,
                        "block_index": block.index,
                        "type": tx_type,
                    }
                )
            if len(entries) >= limit:
                return entries
    return entries
