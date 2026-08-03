"""Block proposer schedule — deterministic round-robin over the validator set.

The proposer for height H is validators_sorted_by_pubkey[H % N]. Every hub computes
the same schedule, so equal-height forks resolve deterministically: the block sealed
by the scheduled proposer wins; if neither (or both) match, the lower hash wins.
"""

from __future__ import annotations

from typing import Any


def sorted_validator_pubkeys() -> list[str]:
    from validators import known_validators

    return sorted(known_validators().keys())


def proposer_pubkey_for_height(height: int) -> str:
    pubkeys = sorted_validator_pubkeys()
    if not pubkeys:
        return ""
    return pubkeys[height % len(pubkeys)]


def is_local_turn(height: int) -> bool:
    from validators import validator_info

    scheduled = proposer_pubkey_for_height(height)
    return not scheduled or scheduled == validator_info().public_key


def schedule_snapshot(next_height: int, count: int = 5) -> list[dict[str, Any]]:
    from validators import known_validators

    registry = known_validators()
    rows = []
    for height in range(next_height, next_height + count):
        pubkey = proposer_pubkey_for_height(height)
        info = registry.get(pubkey)
        rows.append(
            {
                "height": height,
                "proposer_pubkey": pubkey,
                "validator_id": info.validator_id if info else None,
                "hub_url": info.hub_url if info else None,
            }
        )
    return rows


def tiebreak_wins(candidate_tip: dict[str, Any], local_tip: dict[str, Any]) -> bool:
    """True if candidate tip beats local tip at the same height."""
    height = int(candidate_tip.get("index", 0))
    scheduled = proposer_pubkey_for_height(height)
    cand_signer = str((candidate_tip.get("proof") or {}).get("validator_pubkey", ""))
    local_signer = str((local_tip.get("proof") or {}).get("validator_pubkey", ""))
    if scheduled:
        if cand_signer == scheduled and local_signer != scheduled:
            return True
        if local_signer == scheduled and cand_signer != scheduled:
            return False
    return str(candidate_tip.get("hash", "")) < str(local_tip.get("hash", ""))
