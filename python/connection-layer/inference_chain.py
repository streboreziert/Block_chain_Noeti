"""Proof-of-Inference blockchain — on-chain MLC, signed txs, state roots."""

from __future__ import annotations

import hashlib
import json
import os
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import chain_store
from chain_state import (
    apply_transactions,
    credit_tx,
    drain_mempool,
    rebuild_state_from_chain,
    state_root,
)
from models.task import TaskSummary
from proof_hash import sha256_text, worker_proof_row

CHAIN_PATH = Path(__file__).parent / "data" / "chain.json"
PROOF_TYPE = "proof_of_inference"
CHAIN_VERSION = 4
VALIDATOR_FIELDS = ("validator_id", "validator_pubkey", "validator_signature")

# Finality: reorgs deeper than this many blocks from the tip are refused.
MAX_REORG_DEPTH = int(os.environ.get("MAX_REORG_DEPTH", "24"))


def _reset_allowed() -> bool:
    return os.environ.get("ALLOW_CHAIN_RESET", "").strip().lower() in {"1", "true", "yes"}


def _scheduled_proposer(height: int) -> str:
    try:
        from schedule import proposer_pubkey_for_height

        return proposer_pubkey_for_height(height)
    except Exception:
        return ""


@dataclass
class Block:
    index: int
    timestamp: float
    data: str
    previous_hash: str
    proof: dict[str, Any]
    hash: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "timestamp": self.timestamp,
            "time": datetime.fromtimestamp(self.timestamp).strftime("%Y-%m-%d %H:%M:%S"),
            "data": self.data,
            "previous_hash": self.previous_hash,
            "proof": self.proof,
            "hash": self.hash,
            "hash_short": f"{self.hash[:10]}…{self.hash[-6:]}" if self.hash else "",
        }


class InferenceBlockchain:
    def __init__(self) -> None:
        self.chain: list[Block] = [self._genesis()]
        # Incremental caches — avoid replaying the whole chain on every block/query.
        self._state: dict[str, dict[str, Any]] = {}
        self._state_key: tuple[int, str] = (0, "")
        self._valid_key: tuple[int, str] = (0, "")
        self._valid_result: bool = False

    def _cache_key(self) -> tuple[int, str]:
        return (len(self.chain), self.chain[-1].hash if self.chain else "")

    def _state_internal(self) -> dict[str, dict[str, Any]]:
        """Current account state, rebuilt only when the chain changed underneath us."""
        key = self._cache_key()
        if key != self._state_key:
            self._state = rebuild_state_from_chain([block.to_dict() for block in self.chain])
            self._state_key = key
        return self._state

    def _set_state_cache(self, state: dict[str, dict[str, Any]]) -> None:
        self._state = state
        self._state_key = self._cache_key()

    def is_valid_cached(self) -> bool:
        key = self._cache_key()
        if key != self._valid_key:
            self._valid_result = self.is_valid_structure() and self.is_valid_state()
            self._valid_key = key
        return self._valid_result

    def _genesis(self) -> Block:
        from treasury import treasury_wallet

        treasury_address = treasury_wallet().address
        transactions = [
            {
                "type": "credit",
                "to": treasury_address,
                "amount": 1_000_000.0,
                "reason": "Genesis MLC supply — network treasury",
                "timestamp": time.time(),
            }
        ]
        state = rebuild_state_from_chain([])
        state, _ = apply_transactions(state, transactions)
        proof = {
            "chain_version": CHAIN_VERSION,
            "proof_type": PROOF_TYPE,
            "task_id": "genesis",
            "consensus": "MLC network genesis — useful inference replaces hash mining",
            "mlc_distributed": 0.0,
            "workers": [],
            "transactions": transactions,
            "state_root": state_root(state),
        }
        block = Block(
            index=0,
            timestamp=time.time(),
            data="Genesis — Noetis Compute Lab inference chain",
            previous_hash="0",
            proof=proof,
        )
        return self._seal_block(block)

    @staticmethod
    def _merkle_root(items: list[str]) -> str:
        if not items:
            return hashlib.sha256(b"").hexdigest()
        layer = [hashlib.sha256(item.encode()).hexdigest() for item in items]
        while len(layer) > 1:
            if len(layer) % 2:
                layer.append(layer[-1])
            layer = [
                hashlib.sha256((layer[i] + layer[i + 1]).encode()).hexdigest()
                for i in range(0, len(layer), 2)
            ]
        return layer[0]

    def _proof_for_hash(self, proof: dict[str, Any]) -> dict[str, Any]:
        trimmed = dict(proof)
        for key in VALIDATOR_FIELDS:
            trimmed.pop(key, None)
        trimmed.pop("cosignatures", None)
        return trimmed

    def _hash(self, block: Block) -> str:
        payload = {
            "index": block.index,
            "timestamp": block.timestamp,
            "data": block.data,
            "previous_hash": block.previous_hash,
            "proof": self._proof_for_hash(block.proof),
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

    def _seal_block(self, block: Block) -> Block:
        from validators import sign_block_proof, verify_block_validator

        block.hash = self._hash(block)
        block.proof.update(sign_block_proof(block.proof, block.hash))
        if not verify_block_validator(block.proof, block.hash):
            raise ValueError("Failed to seal block — invalid validator signature")
        return block

    def _finalize_commit(self, block: Block) -> Block:
        from consensus import finalize_block_cosignatures, has_quorum

        block_dict = block.to_dict()
        finalized = finalize_block_cosignatures(block_dict)
        block.proof = finalized["proof"]
        if not has_quorum(block.proof, block.hash):
            raise ValueError("Insufficient validator cosignature quorum")

        prior_state = self._state_internal()
        transactions = (block.proof or {}).get("transactions") or []
        next_state, _ = apply_transactions(prior_state, transactions)

        self.chain.append(block)
        self._set_state_cache(next_state)
        chain_store.append_block(block.to_dict())
        try:
            from gossip_mesh import get_mesh

            get_mesh().announce_block(block.to_dict())
        except Exception:
            pass
        return block

    @property
    def last_block(self) -> Block:
        return self.chain[-1]

    def current_state(self) -> dict[str, dict[str, Any]]:
        # Copy so callers can't corrupt the incremental cache.
        return deepcopy(self._state_internal())

    def is_valid_structure(self, *, require_tip_quorum: bool = True) -> bool:
        if not self.chain:
            return False
        genesis = self.chain[0]
        if genesis.index != 0 or genesis.previous_hash != "0":
            return False
        if genesis.hash != self._hash(genesis):
            return False

        last_index = len(self.chain) - 1
        for index in range(1, len(self.chain)):
            current = self.chain[index]
            previous = self.chain[index - 1]
            if current.index != previous.index + 1:
                return False
            if current.previous_hash != previous.hash:
                return False
            if current.hash != self._hash(current):
                return False
            proof = current.proof or {}
            if proof.get("proof_type") != PROOF_TYPE:
                return False
            workers = proof.get("workers") or []
            expected_merkle = self._merkle_root(
                [json.dumps(row, sort_keys=True) for row in workers]
            )
            if proof.get("merkle_root") and proof["merkle_root"] != expected_merkle:
                return False
            if index > 0 and proof.get("validator_pubkey"):
                from consensus import has_quorum
                from validators import verify_block_validator

                if not verify_block_validator(proof, current.hash):
                    return False
                # The unfinalized tip is validated during cosigning, before its
                # cosignatures exist — skip the quorum check there only.
                if require_tip_quorum or index != last_index:
                    if not has_quorum(proof, current.hash):
                        return False
        return True

    def is_valid_state(self) -> bool:
        state: dict[str, dict[str, Any]] = {}
        for block in self.chain:
            proof = block.proof or {}
            transactions = proof.get("transactions") or []
            state, errors = apply_transactions(state, transactions)
            if errors:
                return False
            expected_root = state_root(state)
            if proof.get("state_root") and proof["state_root"] != expected_root:
                return False
        return True

    def _blocks_from_payload(self, payload: list[dict[str, Any]]) -> list[Block]:
        return [
            Block(
                index=item["index"],
                timestamp=item["timestamp"],
                data=item["data"],
                previous_hash=item["previous_hash"],
                proof=item["proof"],
                hash=item.get("hash", ""),
            )
            for item in payload
        ]

    def _fork_depth(self, payload: list[dict[str, Any]]) -> int:
        """How many local blocks a candidate chain would rewrite (0 = pure extension)."""
        divergence = len(self.chain)
        for index, block in enumerate(self.chain):
            if index >= len(payload) or payload[index].get("hash") != block.hash:
                divergence = index
                break
        return len(self.chain) - divergence

    def _finality_error(self, payload: list[dict[str, Any]]) -> str | None:
        if len(self.chain) <= 1 or _reset_allowed():
            return None
        if payload and self.chain and payload[0].get("hash") != self.chain[0].hash:
            return "Rejected: genesis mismatch (finality)"
        depth = self._fork_depth(payload)
        if depth > MAX_REORG_DEPTH:
            return f"Rejected: reorg depth {depth} exceeds finality limit {MAX_REORG_DEPTH}"
        return None

    def replace_chain(self, payload: list[dict[str, Any]]) -> None:
        finality = self._finality_error(payload)
        if finality:
            raise ValueError(finality)
        candidate = self._blocks_from_payload(payload)
        previous = self.chain
        self.chain = candidate
        if not self.is_valid_structure() or not self.is_valid_state():
            self.chain = previous
            raise ValueError("Rejected invalid chain")
        self._save()

    def merge_chain(self, payload: list[dict[str, Any]]) -> dict[str, Any]:
        if len(payload) < len(self.chain):
            return {"ok": True, "action": "noop", "length": len(self.chain)}
        if not payload or not self.chain:
            return {"ok": True, "action": "noop", "length": len(self.chain)}

        if len(payload) == len(self.chain):
            if payload[-1].get("hash") == self.last_block.hash:
                return {"ok": True, "action": "noop", "length": len(self.chain)}
            # New federation peer may start with a different genesis — allow one-time replace.
            if len(self.chain) == 1:
                return self._replace_if_valid(payload, action="replaced")
            # Same-height fork: deterministic proposer-schedule tiebreak.
            finality = self._finality_error(payload)
            if finality:
                return {"ok": False, "error": finality, "rejected": True}
            try:
                from schedule import tiebreak_wins

                candidate_wins = tiebreak_wins(payload[-1], self.last_block.to_dict())
            except Exception:
                candidate_wins = payload[-1].get("hash", "") < self.last_block.hash
            if not candidate_wins:
                return {"ok": True, "action": "noop", "reason": "local tip wins tiebreak", "length": len(self.chain)}
            return self._replace_if_valid(payload, action="fork_resolved")

        finality = self._finality_error(payload)
        if finality:
            return {"ok": False, "error": finality, "rejected": True}
        return self._replace_if_valid(payload, action="merged")

    def _replace_if_valid(self, payload: list[dict[str, Any]], *, action: str) -> dict[str, Any]:
        probe = InferenceBlockchain()
        probe.chain = probe._blocks_from_payload(payload)
        if not probe.is_valid_structure() or not probe.is_valid_state():
            return {"ok": False, "error": "Rejected invalid chain", "rejected": True}
        self.chain = probe.chain
        self._save()
        return {"ok": True, "action": action, "length": len(self.chain)}

    def _build_inference_transactions(
        self,
        summary: TaskSummary,
        *,
        wallet_by_worker: dict[str, str],
        slash_transactions: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        transactions: list[dict[str, Any]] = []
        transactions.extend(drain_mempool())

        for item in summary.results:
            if not item.matched_consensus or item.reward <= 0:
                continue
            address = wallet_by_worker.get(item.worker_id, item.worker_id)
            transactions.append(
                credit_tx(
                    to_address=address,
                    amount=item.reward,
                    reason=f"Inference reward — task {summary.task_id}",
                    worker_id=item.worker_id,
                    task_id=summary.task_id,
                )
            )

        if slash_transactions:
            transactions.extend(slash_transactions)

        return transactions

    def add_inference_block(
        self,
        summary: TaskSummary,
        *,
        wallet_by_worker: dict[str, str],
        slash_transactions: list[dict[str, Any]] | None = None,
    ) -> Block:
        parent = self.last_block
        winner = min(
            [item for item in summary.results if item.matched_consensus],
            key=lambda item: item.inference_ms,
            default=None,
        )
        mlc_total = round(sum(item.reward for item in summary.results if item.matched_consensus), 4)

        worker_rows = [worker_proof_row(item) for item in summary.results]
        # Prefer explicit prompt_hash (hub-blind wipes summary.prompt).
        prompt_hash = str(getattr(summary, "prompt_hash", "") or "").strip()
        if not prompt_hash and summary.prompt:
            prompt_hash = sha256_text(summary.prompt)
        consensus_hash = sha256_text(summary.consensus_response)
        transactions = self._build_inference_transactions(
            summary,
            wallet_by_worker=wallet_by_worker,
            slash_transactions=slash_transactions,
        )

        prior_state = self._state_internal()
        clean: list[dict[str, Any]] = []
        rolling_state = prior_state
        for tx in transactions:
            _, errors = apply_transactions(rolling_state, [tx])
            if not errors:
                clean.append(tx)
                rolling_state, _ = apply_transactions(rolling_state, [tx])
        transactions = clean
        next_state = rolling_state

        proof = {
            "chain_version": CHAIN_VERSION,
            "proof_type": PROOF_TYPE,
            "task_id": summary.task_id,
            "proposer": _scheduled_proposer(parent.index + 1),
            "decoding": {"temperature": 0.0, "seed": 42},
            "prompt_hash": prompt_hash,
            "consensus_hash": consensus_hash,
            "workers_responded": summary.workers_responded,
            "workers_matched": summary.workers_matched,
            "winner": winner.worker_id if winner else None,
            "mlc_distributed": mlc_total,
            "merkle_root": self._merkle_root(
                [json.dumps(row, sort_keys=True) for row in worker_rows]
            ),
            "workers": worker_rows,
            "transactions": transactions,
            "state_root": state_root(next_state),
        }

        block = Block(
            index=parent.index + 1,
            timestamp=time.time(),
            data=f"Inference task {summary.task_id}",
            previous_hash=parent.hash,
            proof=proof,
        )
        block = self._seal_block(block)
        return self._finalize_commit(block)

    def add_state_block(self, transactions: list[dict[str, Any]], data: str) -> Block:
        parent = self.last_block
        prior_state = self._state_internal()
        clean: list[dict[str, Any]] = []
        rolling_state = prior_state
        for tx in transactions:
            _, errors = apply_transactions(rolling_state, [tx])
            if not errors:
                clean.append(tx)
                rolling_state, _ = apply_transactions(rolling_state, [tx])
        proof = {
            "chain_version": CHAIN_VERSION,
            "proof_type": PROOF_TYPE,
            "task_id": "state",
            "proposer": _scheduled_proposer(parent.index + 1),
            "consensus": data,
            "mlc_distributed": 0.0,
            "workers": [],
            "transactions": clean,
            "state_root": state_root(rolling_state),
        }
        block = Block(
            index=parent.index + 1,
            timestamp=time.time(),
            data=data,
            previous_hash=parent.hash,
            proof=proof,
        )
        block = self._seal_block(block)
        return self._finalize_commit(block)

    def headers_snapshot(self) -> dict[str, Any]:
        headers = []
        for block in self.chain:
            proof = block.proof or {}
            headers.append(
                {
                    "index": block.index,
                    "hash": block.hash,
                    "previous_hash": block.previous_hash,
                    "timestamp": block.timestamp,
                    "state_root": proof.get("state_root"),
                    "validator_id": proof.get("validator_id"),
                    "cosignatures": len(proof.get("cosignatures") or []),
                }
            )
        return {
            "length": len(headers),
            "valid": self.is_valid_cached(),
            "chain_version": CHAIN_VERSION,
            "finality_depth": MAX_REORG_DEPTH,
            "headers": headers,
        }

    def get_block(self, index: int) -> dict[str, Any] | None:
        for block in self.chain:
            if block.index == index:
                return block.to_dict()
        return None

    def _save(self) -> None:
        blocks = [block.to_dict() for block in self.chain]
        chain_store.replace_all(blocks)
        self._state_key = (0, "")  # force state rebuild on next access

    def _backup_corrupt(self, payload: list[dict[str, Any]], reason: str) -> Path:
        backup = CHAIN_PATH.parent / f"chain.corrupt-{int(time.time())}.json"
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_text(json.dumps({"reason": reason, "blocks": payload}, indent=2))
        return backup

    def load(self) -> None:
        # One-time migration from the legacy JSON file into SQLite.
        migrated = chain_store.migrate_from_json(CHAIN_PATH)
        if migrated:
            print(f"[chain] migrated {migrated} blocks from chain.json to SQLite")

        payload = chain_store.load_blocks()
        if not payload:
            self._save()  # persist the fresh genesis
            return

        self.chain = self._blocks_from_payload(payload)
        genesis_version = (self.chain[0].proof or {}).get("chain_version") if self.chain else None

        if genesis_version != CHAIN_VERSION:
            # Explicit protocol upgrade — back up the old chain, start fresh.
            backup = self._backup_corrupt(payload, f"chain_version {genesis_version} != {CHAIN_VERSION}")
            print(f"[chain] version upgrade — old chain backed up to {backup.name}")
            self.chain = [self._genesis()]
            self._save()
            return

        if not self.is_valid_structure() or not self.is_valid_state():
            backup = self._backup_corrupt(payload, "failed validation on load")
            if _reset_allowed():
                print(f"[chain] INVALID chain backed up to {backup.name} — reset (ALLOW_CHAIN_RESET=1)")
                self.chain = [self._genesis()]
                self._save()
                return
            raise RuntimeError(
                f"Stored chain failed validation — backed up to {backup.name}. "
                "Refusing to silently regenerate genesis. Investigate, or restart with ALLOW_CHAIN_RESET=1."
            )

    def snapshot(self) -> dict[str, Any]:
        return {
            "length": len(self.chain),
            "valid": self.is_valid_cached(),
            "token": "MLC",
            "proof_type": PROOF_TYPE,
            "chain_version": CHAIN_VERSION,
            "finality_depth": MAX_REORG_DEPTH,
            "state_root": state_root(self._state_internal()),
            "blocks": [block.to_dict() for block in reversed(self.chain[-12:])],
        }

    def full_snapshot(self) -> dict[str, Any]:
        return {
            "length": len(self.chain),
            "valid": self.is_valid_cached(),
            "token": "MLC",
            "proof_type": PROOF_TYPE,
            "chain_version": CHAIN_VERSION,
            "finality_depth": MAX_REORG_DEPTH,
            "state_root": state_root(self._state_internal()),
            "blocks": [block.to_dict() for block in self.chain],
        }


_chain = InferenceBlockchain()
_chain.load()


def get_chain() -> InferenceBlockchain:
    return _chain


def finalize_on_chain(
    summary: TaskSummary,
    *,
    wallet_by_worker: dict[str, str],
    slash_transactions: list[dict[str, Any]] | None = None,
) -> Block:
    return _chain.add_inference_block(
        summary,
        wallet_by_worker=wallet_by_worker,
        slash_transactions=slash_transactions,
    )
