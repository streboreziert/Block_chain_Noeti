"""Multi-writer consensus — collect cosignatures from federation validators."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from validators import hub_validator_wallet, known_validators, registry_validators, sign_block_proof, validator_info

QUORUM_ENV = int(os.environ.get("COSIGN_QUORUM", "0"))


def effective_quorum() -> int:
    # Quorum follows the bootstrap-trusted registry, not the open on-chain set —
    # otherwise registering a dead validator on-chain would halt block production.
    if QUORUM_ENV > 0:
        return QUORUM_ENV
    count = len(registry_validators())
    return 2 if count >= 2 else 1


def cosign_payload(proof: dict[str, Any], block_hash: str, validator_id: str, public_key: str) -> dict[str, str]:
    return {
        "block_hash": block_hash,
        "state_root": proof.get("state_root"),
        "task_id": proof.get("task_id"),
        "validator_id": validator_id,
        "public_key": public_key,
    }


def make_cosignature(proof: dict[str, Any], block_hash: str) -> dict[str, str]:
    wallet = hub_validator_wallet()
    payload = cosign_payload(proof, block_hash, wallet.name, wallet.public_key_hex)
    sig = wallet.sign_payload(payload)
    return {
        "validator_id": wallet.name,
        "validator_pubkey": wallet.public_key_hex,
        "validator_signature": sig,
    }


def verify_cosignature(cosign: dict[str, Any], proof: dict[str, Any], block_hash: str) -> bool:
    pubkey = str(cosign.get("validator_pubkey", ""))
    signature = str(cosign.get("validator_signature", ""))
    if not pubkey or not signature or pubkey not in known_validators():
        return False
    payload = cosign_payload(
        proof,
        block_hash,
        str(cosign.get("validator_id", "")),
        pubkey,
    )
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        from crypto_wallet import canonical_json

        key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(pubkey))
        key.verify(bytes.fromhex(signature), canonical_json(payload))
        return True
    except Exception:
        return False


def signature_count(proof: dict[str, Any], block_hash: str) -> int:
    from validators import verify_block_validator

    count = 0
    if verify_block_validator(proof, block_hash):
        count += 1
    seen = {proof.get("validator_pubkey")}
    for cosign in proof.get("cosignatures") or []:
        pubkey = cosign.get("validator_pubkey")
        if pubkey in seen:
            continue
        if verify_cosignature(cosign, proof, block_hash):
            count += 1
            seen.add(pubkey)
    return count


def has_quorum(proof: dict[str, Any], block_hash: str) -> bool:
    required = max(1, min(effective_quorum(), len(known_validators())))
    return signature_count(proof, block_hash) >= required


def _post_json(url: str, path: str, body: dict[str, Any], timeout: float = 8.0) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"{url.rstrip('/')}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _sync_peer_to_local_tip(peer_url: str) -> None:
    """Push our committed chain so the peer's tip matches before it cosigns the next block."""
    from inference_chain import get_chain

    local = get_chain()
    payload = {"blocks": [b.to_dict() for b in local.chain], "length": len(local.chain)}
    try:
        _post_json(peer_url, "/api/chain/sync", payload)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
        pass


def collect_cosignatures(block: dict[str, Any]) -> list[dict[str, str]]:
    local = validator_info()
    local_url = local.hub_url.rstrip("/")
    proof = block.get("proof") or {}
    block_hash = block.get("hash", "")
    cosignatures: list[dict[str, str]] = []

    for peer in known_validators().values():
        peer_url = peer.hub_url.rstrip("/")
        if not peer_url or peer_url == local_url:
            continue
        if peer.public_key == local.public_key:
            continue
        try:
            result = _post_json(peer_url, "/api/chain/cosign", {"block": block})
            cosign = result.get("cosignature")
            if not (cosign and verify_cosignature(cosign, proof, block_hash)):
                # Peer likely lagging — fast-forward it to our tip and retry once.
                _sync_peer_to_local_tip(peer_url)
                result = _post_json(peer_url, "/api/chain/cosign", {"block": block})
                cosign = result.get("cosignature")
            if cosign and verify_cosignature(cosign, proof, block_hash):
                cosignatures.append(cosign)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
            try:
                _sync_peer_to_local_tip(peer_url)
                result = _post_json(peer_url, "/api/chain/cosign", {"block": block})
                cosign = result.get("cosignature")
                if cosign and verify_cosignature(cosign, proof, block_hash):
                    cosignatures.append(cosign)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
                continue
    return cosignatures


def finalize_block_cosignatures(block: dict[str, Any]) -> dict[str, Any]:
    cosignatures = collect_cosignatures(block)
    if cosignatures:
        block.setdefault("proof", {})["cosignatures"] = cosignatures
    return block
