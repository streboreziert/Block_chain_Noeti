"""Hub validator keys — block signatures and federation registry."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from crypto_wallet import Wallet, canonical_json, create_wallet, load_wallet, save_wallet, verify_signature

VALIDATOR_PATH = Path(__file__).parent / "data" / "validator.json"
FEDERATION_PATH = Path(__file__).parent / "data" / "federation.json"
VALIDATOR_WALLET_NAME = "hub-validator"


@dataclass
class ValidatorInfo:
    validator_id: str
    public_key: str
    address: str
    hub_url: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "validator_id": self.validator_id,
            "public_key": self.public_key,
            "address": self.address,
            "hub_url": self.hub_url,
        }


def _load_federation() -> dict[str, Any]:
    if FEDERATION_PATH.exists():
        return json.loads(FEDERATION_PATH.read_text())
    return {"validators": {}}


def _save_federation(store: dict[str, Any]) -> None:
    FEDERATION_PATH.parent.mkdir(parents=True, exist_ok=True)
    FEDERATION_PATH.write_text(json.dumps(store, indent=2))


def hub_validator_wallet() -> Wallet:
    wallet = load_wallet(VALIDATOR_WALLET_NAME)
    if wallet:
        return wallet
    wallet = create_wallet(VALIDATOR_WALLET_NAME)
    save_wallet(wallet)
    meta = {
        "validator_id": wallet.name,
        "public_key": wallet.public_key_hex,
        "address": wallet.address,
        "created": time.time(),
    }
    VALIDATOR_PATH.write_text(json.dumps(meta, indent=2))
    return wallet


def validator_info() -> ValidatorInfo:
    wallet = hub_validator_wallet()
    hub_url = ""
    if VALIDATOR_PATH.exists():
        hub_url = json.loads(VALIDATOR_PATH.read_text()).get("hub_url", "")
    return ValidatorInfo(
        validator_id=wallet.name,
        public_key=wallet.public_key_hex,
        address=wallet.address,
        hub_url=hub_url,
    )


def set_validator_hub_url(hub_url: str) -> None:
    wallet = hub_validator_wallet()
    VALIDATOR_PATH.write_text(
        json.dumps(
            {
                "validator_id": wallet.name,
                "public_key": wallet.public_key_hex,
                "address": wallet.address,
                "hub_url": hub_url,
                "updated": time.time(),
            },
            indent=2,
        )
    )


def sign_block_proof(proof: dict[str, Any], block_hash: str) -> dict[str, str]:
    wallet = hub_validator_wallet()
    payload = {
        "block_hash": block_hash,
        "state_root": proof.get("state_root"),
        "task_id": proof.get("task_id"),
        "validator_id": wallet.name,
        "public_key": wallet.public_key_hex,
    }
    signature = wallet.sign_payload(payload)
    return {
        "validator_id": wallet.name,
        "validator_pubkey": wallet.public_key_hex,
        "validator_signature": signature,
    }


def registry_validators() -> dict[str, ValidatorInfo]:
    """Bootstrap-trusted federation set (local + federation.json). Governs quorum size."""
    store = _load_federation()
    validators: dict[str, ValidatorInfo] = {}
    local = validator_info()
    validators[local.public_key] = local
    for entry in (store.get("validators") or {}).values():
        info = ValidatorInfo(
            validator_id=str(entry.get("validator_id", "")),
            public_key=str(entry.get("public_key", "")),
            address=str(entry.get("address", "")),
            hub_url=str(entry.get("hub_url", "")),
        )
        if info.public_key:
            validators[info.public_key] = info
    return validators


def known_validators() -> dict[str, ValidatorInfo]:
    """Registry validators plus stake-backed on-chain validators.

    On-chain validators are recognized for block signatures and the proposer
    schedule, but do NOT raise the cosign quorum — otherwise anyone could halt
    the chain by registering a validator that never cosigns.
    """
    validators = registry_validators()
    for entry in on_chain_validator_rows():
        info = ValidatorInfo(
            validator_id=str(entry.get("validator_id", "")),
            public_key=str(entry.get("public_key", "")),
            address=str(entry.get("address", "")),
            hub_url=str(entry.get("hub_url", "")),
        )
        if info.public_key:
            validators.setdefault(info.public_key, info)
    return validators


def on_chain_validator_rows() -> list[dict[str, Any]]:
    """Validators registered on-chain via validator_register tx (stake-backed)."""
    try:
        from chain_state import on_chain_validators
        from inference_chain import get_chain

        return on_chain_validators(get_chain()._state_internal())
    except Exception:
        # Chain still bootstrapping (module import in progress) — registry only.
        return []


def register_peer_trusted(*, hub_url: str, validator_id: str, public_key: str, address: str) -> dict[str, Any]:
    store = _load_federation()
    store.setdefault("validators", {})[public_key] = {
        "hub_url": hub_url,
        "validator_id": validator_id,
        "public_key": public_key,
        "address": address,
        "registered_at": time.time(),
        "trusted_bootstrap": True,
    }
    _save_federation(store)
    return {"ok": True, "validator_id": validator_id, "hub_url": hub_url, "trusted": True}


def register_peer(
    *,
    hub_url: str,
    validator_id: str,
    public_key: str,
    address: str,
    signature: str,
    timestamp: float | None = None,
) -> dict[str, Any]:
    body = {
        "hub_url": hub_url,
        "validator_id": validator_id,
        "public_key": public_key,
        "address": address,
        "timestamp": float(timestamp if timestamp is not None else time.time()),
    }
    signed = {**body, "from": address, "public_key": public_key, "signature": signature}
    if not verify_signature(signed):
        raise ValueError("Invalid validator registration signature")

    store = _load_federation()
    store.setdefault("validators", {})[public_key] = {
        **body,
        "registered_at": time.time(),
    }
    _save_federation(store)
    return {"ok": True, "validator_id": validator_id, "hub_url": hub_url}


def verify_block_validator(proof: dict[str, Any], block_hash: str) -> bool:
    pubkey = str(proof.get("validator_pubkey", ""))
    signature = str(proof.get("validator_signature", ""))
    if not pubkey or not signature:
        return False
    if pubkey not in known_validators():
        return False
    payload = {
        "block_hash": block_hash,
        "state_root": proof.get("state_root"),
        "task_id": proof.get("task_id"),
        "validator_id": proof.get("validator_id"),
        "public_key": pubkey,
    }
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(pubkey))
        key.verify(bytes.fromhex(signature), canonical_json(payload))
        return True
    except Exception:
        return False
