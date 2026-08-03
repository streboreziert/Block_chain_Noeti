"""E2E task encryption — X25519 + AES-GCM hub ↔ compute."""

from __future__ import annotations

import base64
import hashlib
import os
from typing import Any

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat


def _shared_key(private_key: X25519PrivateKey, public_key: X25519PublicKey) -> bytes:
    return hashlib.sha256(private_key.exchange(public_key)).digest()


def generate_enc_keypair() -> tuple[str, str]:
    private_key = X25519PrivateKey.generate()
    public_key = private_key.public_key()
    priv_hex = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()).hex()
    pub_hex = public_key.public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
    return pub_hex, priv_hex


def encrypt_task(prompt: str, compute_enc_pubkey_hex: str) -> dict[str, str]:
    ephemeral = X25519PrivateKey.generate()
    peer_public = X25519PublicKey.from_public_bytes(bytes.fromhex(compute_enc_pubkey_hex))
    key = _shared_key(ephemeral, peer_public)
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, prompt.encode("utf-8"), None)
    ephem_pub = ephemeral.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
    ephem_priv = ephemeral.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()).hex()
    return {
        "encrypted": True,
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ephem_pubkey": ephem_pub,
        "_hub_ephem_priv": ephem_priv,
    }


def decrypt_task(payload: dict[str, Any], compute_enc_privkey_hex: str) -> str:
    if not payload.get("encrypted"):
        return str(payload.get("prompt", ""))
    ephemeral_public = X25519PublicKey.from_public_bytes(bytes.fromhex(str(payload["ephem_pubkey"])))
    private_key = X25519PrivateKey.from_private_bytes(bytes.fromhex(compute_enc_privkey_hex))
    key = _shared_key(private_key, ephemeral_public)
    nonce = base64.b64decode(str(payload["nonce"]))
    ciphertext = base64.b64decode(str(payload["ciphertext"]))
    return AESGCM(key).decrypt(nonce, ciphertext, None).decode("utf-8")


def encrypt_response(response: str, hub_ephem_pubkey_hex: str, compute_enc_privkey_hex: str) -> dict[str, str]:
    hub_public = X25519PublicKey.from_public_bytes(bytes.fromhex(hub_ephem_pubkey_hex))
    compute_private = X25519PrivateKey.from_private_bytes(bytes.fromhex(compute_enc_privkey_hex))
    key = _shared_key(compute_private, hub_public)
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, response.encode("utf-8"), None)
    return {
        "response_encrypted": True,
        "response_ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "response_nonce": base64.b64encode(nonce).decode("ascii"),
    }


def decrypt_response_payload(
    response_payload: dict[str, Any],
    *,
    hub_ephem_priv_hex: str,
    compute_enc_pubkey_hex: str,
) -> str:
    if not response_payload.get("response_encrypted"):
        return str(response_payload.get("response", ""))
    hub_private = X25519PrivateKey.from_private_bytes(bytes.fromhex(hub_ephem_priv_hex))
    compute_public = X25519PublicKey.from_public_bytes(bytes.fromhex(compute_enc_pubkey_hex))
    key = _shared_key(hub_private, compute_public)
    nonce = base64.b64decode(str(response_payload["response_nonce"]))
    ciphertext = base64.b64decode(str(response_payload["response_ciphertext"]))
    return AESGCM(key).decrypt(nonce, ciphertext, None).decode("utf-8")
