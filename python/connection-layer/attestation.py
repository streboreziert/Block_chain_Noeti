"""Model attestation — signed proof compute ran the claimed model."""

from __future__ import annotations

import hashlib
import time
from typing import Any

from crypto_wallet import Wallet, verify_signature
from proof_hash import sha256_text


def model_digest(model: str) -> str:
    return sha256_text(model.strip())


def build_attestation(
    wallet: Wallet,
    *,
    task_id: str,
    model: str,
    response: str,
    inference_ms: float,
    prompt_hash: str = "",
) -> dict[str, Any]:
    output_hash = sha256_text(response)
    body = {
        "type": "model_attestation",
        "from": wallet.address,
        "public_key": wallet.public_key_hex,
        "task_id": task_id,
        "model": model,
        "model_hash": model_digest(model),
        "output_hash": output_hash,
        "prompt_hash": prompt_hash,
        "inference_ms": round(inference_ms, 1),
        "timestamp": time.time(),
    }
    return wallet.sign_transaction(body)


def verify_attestation(attestation: dict[str, Any]) -> tuple[bool, str]:
    if attestation.get("type") != "model_attestation":
        return False, "Invalid attestation type"
    if not verify_signature(attestation):
        return False, "Invalid attestation signature"
    model = str(attestation.get("model", ""))
    if attestation.get("model_hash") != model_digest(model):
        return False, "Model hash mismatch"
    return True, "valid"
