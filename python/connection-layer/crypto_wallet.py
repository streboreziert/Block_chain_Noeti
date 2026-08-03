"""Ed25519 wallets for MLC — signed transfers and staking."""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

WALLET_DIR = Path(__file__).parent / "data" / "wallets"
ADDRESS_PREFIX = "mlc"


@dataclass
class Wallet:
    name: str
    address: str
    public_key_hex: str
    private_key_hex: str

    def to_public_dict(self) -> dict[str, str]:
        return {"name": self.name, "address": self.address, "public_key": self.public_key_hex}

    def sign_payload(self, payload: dict[str, Any]) -> str:
        message = canonical_json(payload)
        private_key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(self.private_key_hex))
        return private_key.sign(message).hex()

    def sign_transaction(self, tx: dict[str, Any]) -> dict[str, Any]:
        body = {key: value for key, value in tx.items() if key != "signature"}
        body["public_key"] = self.public_key_hex
        signed = dict(body)
        signed["signature"] = self.sign_payload(body)
        return signed


def canonical_json(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def address_from_public_key(public_key_hex: str) -> str:
    return f"{ADDRESS_PREFIX}{public_key_hex[:42]}"


def create_wallet(name: str = "default") -> Wallet:
    private_key = Ed25519PrivateKey.generate()
    private_bytes = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    public_hex = public_bytes.hex()
    return Wallet(
        name=name,
        address=address_from_public_key(public_hex),
        public_key_hex=public_hex,
        private_key_hex=private_bytes.hex(),
    )


def load_wallet(name: str = "default") -> Wallet | None:
    path = WALLET_DIR / f"{name}.json"
    if not path.exists():
        return None
    payload = json.loads(path.read_text())
    return Wallet(
        name=payload["name"],
        address=payload["address"],
        public_key_hex=payload["public_key"],
        private_key_hex=payload["private_key_hex"],
    )


def save_wallet(wallet: Wallet) -> Path:
    WALLET_DIR.mkdir(parents=True, exist_ok=True)
    path = WALLET_DIR / f"{wallet.name}.json"
    path.write_text(
        json.dumps(
            {
                "name": wallet.name,
                "address": wallet.address,
                "public_key": wallet.public_key_hex,
                "private_key_hex": wallet.private_key_hex,
            },
            indent=2,
        )
    )
    path.chmod(0o600)
    return path


def get_or_create_wallet(name: str = "default") -> Wallet:
    existing = load_wallet(name)
    if existing:
        return existing
    wallet = create_wallet(name)
    save_wallet(wallet)
    return wallet


def verify_signature(tx: dict[str, Any]) -> bool:
    signature_hex = str(tx.get("signature", ""))
    if not signature_hex:
        return False
    public_key_hex = str(tx.get("public_key", ""))
    address = str(tx.get("from", ""))
    if not public_key_hex and address.startswith(ADDRESS_PREFIX):
        public_key_hex = address[len(ADDRESS_PREFIX) :]
    if len(public_key_hex) != 64:
        return False
    body = {key: value for key, value in tx.items() if key != "signature"}
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        public_key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex))
        public_key.verify(bytes.fromhex(signature_hex), canonical_json(body))
        return address_from_public_key(public_key_hex) == address
    except Exception:
        return False


def random_wallet_name() -> str:
    return f"wallet-{secrets.token_hex(4)}"
