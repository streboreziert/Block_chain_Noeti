"""Automatic federation bootstrap — register peers on startup."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

from validators import hub_validator_wallet, register_peer, validator_info


def _post(url: str, path: str, body: dict[str, Any], timeout: float = 10.0) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"{url.rstrip('/')}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _get(url: str, path: str, timeout: float = 10.0) -> dict[str, Any]:
    request = urllib.request.Request(f"{url.rstrip('/')}{path}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def federation_peers() -> list[str]:
    raw = os.environ.get("FEDERATION_PEERS", "").strip()
    if not raw:
        return []
    return [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]


def canonical_hub_url(public_url: str) -> str:
    return os.environ.get("CANONICAL_HUB_URL", public_url).strip().rstrip("/")


def fetch_remote_blocks(hub_url: str) -> list[dict[str, Any]]:
    payload = _get(hub_url, "/api/chain/full", timeout=30.0)
    blocks = payload.get("blocks") or []
    if not isinstance(blocks, list):
        raise ValueError("Invalid chain payload from hub")
    return blocks


def verify_remote_blocks(blocks: list[dict[str, Any]]) -> bool:
    from inference_chain import InferenceBlockchain

    if not blocks:
        return False
    probe = InferenceBlockchain()
    probe.chain = probe._blocks_from_payload(blocks)
    return probe.is_valid_structure() and probe.is_valid_state()


def pick_canonical_chain(
    url_a: str,
    blocks_a: list[dict[str, Any]],
    url_b: str,
    blocks_b: list[dict[str, Any]],
    *,
    canonical_url: str,
) -> tuple[str, list[dict[str, Any]]]:
    ok_a = verify_remote_blocks(blocks_a)
    ok_b = verify_remote_blocks(blocks_b)
    if ok_a and not ok_b:
        return url_a.rstrip("/"), blocks_a
    if ok_b and not ok_a:
        return url_b.rstrip("/"), blocks_b
    if not ok_a and not ok_b:
        raise ValueError("Neither chain is valid")

    if len(blocks_a) > len(blocks_b):
        return url_a.rstrip("/"), blocks_a
    if len(blocks_b) > len(blocks_a):
        return url_b.rstrip("/"), blocks_b

    tip_a = blocks_a[-1].get("hash", "") if blocks_a else ""
    tip_b = blocks_b[-1].get("hash", "") if blocks_b else ""
    if tip_a == tip_b:
        return url_a.rstrip("/"), blocks_a

    canon = canonical_url.rstrip("/")
    if canon == url_a.rstrip("/"):
        return url_a.rstrip("/"), blocks_a
    if canon == url_b.rstrip("/"):
        return url_b.rstrip("/"), blocks_b
    return url_a.rstrip("/"), blocks_a


def push_chain(hub_url: str, blocks: list[dict[str, Any]]) -> dict[str, Any]:
    return _post(
        hub_url,
        "/api/chain/sync",
        {"blocks": blocks, "length": len(blocks)},
        timeout=60.0,
    )


def sync_chain_with_peer(peer_url: str, public_url: str, *, canonical_url: str | None = None) -> dict[str, Any]:
    from inference_chain import get_chain

    peer = peer_url.rstrip("/")
    local_url = public_url.rstrip("/")
    canon = (canonical_url or canonical_hub_url(public_url)).rstrip("/")

    local = get_chain()
    local_blocks = [block.to_dict() for block in local.chain]
    remote_blocks = fetch_remote_blocks(peer)

    winner_url, winner_blocks = pick_canonical_chain(
        local_url,
        local_blocks,
        peer,
        remote_blocks,
        canonical_url=canon,
    )

    result: dict[str, Any] = {
        "peer": peer,
        "canonical": canon,
        "local_length": len(local_blocks),
        "remote_length": len(remote_blocks),
        "winner": winner_url,
        "winner_length": len(winner_blocks),
    }

    local_tip = local_blocks[-1]["hash"] if local_blocks else ""
    remote_tip = remote_blocks[-1]["hash"] if remote_blocks else ""
    winner_tip = winner_blocks[-1]["hash"] if winner_blocks else ""

    if winner_url == local_url and local_tip != winner_tip:
        local.replace_chain(winner_blocks)
        result["local_action"] = "adopted"
    elif winner_url != local_url:
        local.replace_chain(winner_blocks)
        result["local_action"] = "adopted_from_peer"

    if winner_tip != remote_tip:
        result["remote_push"] = push_chain(peer, winner_blocks)
    if winner_url != local_url and winner_tip != local_tip:
        result["local_was_behind"] = True

    return result


def unify_federation_chains(public_url: str) -> list[dict[str, Any]]:
    from validators import known_validators

    results: list[dict[str, Any]] = []
    canon = canonical_hub_url(public_url)
    peers = {
        peer.rstrip("/")
        for peer in federation_peers()
        if peer.rstrip("/") and peer.rstrip("/") != public_url.rstrip("/")
    }
    for entry in known_validators().values():
        if entry.hub_url:
            peer = entry.hub_url.rstrip("/")
            if peer != public_url.rstrip("/"):
                peers.add(peer)

    for peer in sorted(peers):
        try:
            results.append(sync_chain_with_peer(peer, public_url, canonical_url=canon))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
            results.append({"peer": peer, "chain_sync_error": str(exc)})
    return results


def register_self_with_peer(peer_url: str, public_url: str) -> dict[str, Any]:
    wallet = hub_validator_wallet()
    info = validator_info()
    body = {
        "hub_url": public_url,
        "validator_id": info.validator_id,
        "public_key": info.public_key,
        "address": info.address,
        "timestamp": time.time(),
    }
    signed = wallet.sign_transaction({**body, "from": info.address})
    return _post(
        peer_url,
        "/api/validator/register",
        {
            "hub_url": public_url,
            "validator_id": info.validator_id,
            "public_key": info.public_key,
            "address": info.address,
            "timestamp": body["timestamp"],
            "signature": signed["signature"],
        },
    )


def import_peer_validator(peer_url: str) -> dict[str, Any]:
    from validators import register_peer_trusted

    remote = _get(peer_url, "/api/validator")
    return register_peer_trusted(
        hub_url=peer_url,
        validator_id=str(remote.get("validator_id", "")),
        public_key=str(remote.get("public_key", "")),
        address=str(remote.get("address", "")),
    )


def bootstrap_federation(public_url: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for peer in federation_peers():
        if peer.rstrip("/") == public_url.rstrip("/"):
            continue
        try:
            results.append({"peer": peer, "register": register_self_with_peer(peer, public_url)})
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
            results.append({"peer": peer, "register_error": str(exc)})
        try:
            results.append({"peer": peer, "import": import_peer_validator(peer)})
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
            results.append({"peer": peer, "import_error": str(exc)})
    try:
        results.append({"chain_unify": unify_federation_chains(public_url)})
    except Exception as exc:
        results.append({"chain_unify_error": str(exc)})
    return results
