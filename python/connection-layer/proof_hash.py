"""Content hashing for privacy-preserving on-chain proofs."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def worker_proof_row(result: Any) -> dict[str, Any]:
    return {
        "task_id": result.task_id,
        "worker_id": result.worker_id,
        "response_hash": sha256_text(result.response),
        "inference_ms": round(result.inference_ms, 1),
        "model": result.model,
        "matched_consensus": result.matched_consensus,
        "reward": round(result.reward, 4),
    }
