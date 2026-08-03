"""Hub treasury wallet and rate-limited mainnet onboarding faucet."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from chain_state import credit_tx
from crypto_wallet import Wallet, get_or_create_wallet, load_wallet, save_wallet

TREASURY_NAME = "treasury"
FAUCET_LOG_PATH = Path(__file__).parent / "data" / "faucet_claims.json"
DEFAULT_FAUCET_MAX = 50.0
DEFAULT_FAUCET_COOLDOWN = 86_400.0  # 24h


def treasury_wallet() -> Wallet:
    wallet = load_wallet(TREASURY_NAME)
    if wallet:
        return wallet
    wallet = get_or_create_wallet(TREASURY_NAME)
    save_wallet(wallet)
    return wallet


def _load_claims() -> dict[str, float]:
    if FAUCET_LOG_PATH.exists():
        return json.loads(FAUCET_LOG_PATH.read_text())
    return {}


def _save_claims(claims: dict[str, float]) -> None:
    FAUCET_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    FAUCET_LOG_PATH.write_text(json.dumps(claims, indent=2))


def faucet_mode() -> str:
    # Mainnet default: faucet OFF. Set ALLOW_FAUCET=limited (or 1) for local onboarding.
    # Observer exposes faucet_enabled so operators can verify.
    return os.environ.get("ALLOW_FAUCET", "0").strip().lower()


def faucet_allowed() -> bool:
    return faucet_mode() in {"1", "true", "yes", "limited", "rate_limited"}


def _faucet_max_amount() -> float:
    return float(os.environ.get("FAUCET_MAX_AMOUNT", DEFAULT_FAUCET_MAX))


def _faucet_cooldown() -> float:
    return float(os.environ.get("FAUCET_COOLDOWN_SEC", DEFAULT_FAUCET_COOLDOWN))


def can_claim_faucet(address: str) -> tuple[bool, str]:
    if not faucet_allowed():
        return False, "transfer MLC or earn — faucet is off"
    claims = _load_claims()
    last = claims.get(address)
    if last and (time.time() - last) < _faucet_cooldown():
        remaining = int(_faucet_cooldown() - (time.time() - last))
        return False, f"Already claimed — retry in {remaining // 3600}h {(remaining % 3600) // 60}m"
    return True, "eligible"


def record_faucet_claim(address: str) -> None:
    claims = _load_claims()
    claims[address] = time.time()
    _save_claims(claims)


def grant_onboarding_credit(address: str, amount: float | None = None) -> dict:
    from inference_chain import get_chain

    ok, reason = can_claim_faucet(address)
    if not ok:
        raise ValueError(reason)

    mode = faucet_mode()
    max_amount = _faucet_max_amount()
    credit_amount = min(float(amount or max_amount), max_amount)

    if mode in {"limited", "rate_limited"} and credit_amount > max_amount:
        credit_amount = max_amount

    block = get_chain().add_state_block(
        [
            credit_tx(
                to_address=address,
                amount=credit_amount,
                reason="Mainnet onboarding faucet",
            )
        ],
        data=f"Onboarding faucet — {credit_amount} MLC",
    )
    record_faucet_claim(address)
    return {
        "ok": True,
        "address": address,
        "amount": credit_amount,
        "block_index": block.index,
        "mode": mode,
        "treasury_address": treasury_wallet().address,
    }


def distribute_from_treasury(to_address: str, amount: float, *, nonce: int) -> dict:
    from inference_chain import get_chain

    wallet = treasury_wallet()
    state = get_chain().current_state()
    row = state.get(wallet.address, {})
    balance = float(row.get("balance", 0))
    if balance < amount:
        raise ValueError(f"Treasury balance {balance} MLC — insufficient for {amount}")

    tx = wallet.sign_transaction(
        {
            "type": "transfer",
            "from": wallet.address,
            "to": to_address,
            "amount": round(amount, 6),
            "nonce": nonce,
            "timestamp": time.time(),
        }
    )
    block = get_chain().add_state_block([tx], data=f"Treasury transfer → {to_address[:16]}…")
    return {"ok": True, "block_index": block.index, "amount": amount, "to": to_address}
