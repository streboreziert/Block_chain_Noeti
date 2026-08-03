"""P2P chain sync — download, verify, and reject invalid blocks."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from chain_state import rebuild_state_from_chain, state_root
from inference_chain import CHAIN_PATH, InferenceBlockchain, get_chain

SYNC_META_PATH = Path(__file__).parent / "data" / "sync_meta.json"


def _api_get(url: str, path: str, timeout: float = 30.0) -> dict[str, Any]:
    request = urllib.request.Request(f"{url.rstrip('/')}{path}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _api_post(url: str, path: str, body: dict[str, Any], timeout: float = 60.0) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"{url.rstrip('/')}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


class ChainSyncer:
    def __init__(self, hub_url: str, *, light: bool = False) -> None:
        self.hub_url = hub_url.rstrip("/")
        self.light = light
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_sync: float = 0.0
        self.last_error: str | None = None
        self.last_result: dict[str, Any] = {}

    def fetch_remote_headers(self) -> list[dict[str, Any]]:
        payload = _api_get(self.hub_url, "/api/chain/headers")
        headers = payload.get("headers") or []
        if not isinstance(headers, list):
            raise RuntimeError("Invalid headers payload from hub")
        return headers

    def fetch_block(self, index: int) -> dict[str, Any]:
        return _api_get(self.hub_url, f"/api/chain/block/{index}")

    def fetch_remote_blocks(self) -> list[dict[str, Any]]:
        payload = _api_get(self.hub_url, "/api/chain/full")
        blocks = payload.get("blocks") or []
        if not isinstance(blocks, list):
            raise RuntimeError("Invalid chain payload from hub")
        return blocks

    def verify_remote_chain(self, blocks: list[dict[str, Any]]) -> tuple[bool, str]:
        if not blocks:
            return False, "Empty chain rejected"

        probe = InferenceBlockchain()
        probe.chain = probe._blocks_from_payload(blocks)
        if not probe.is_valid_structure():
            return False, "Invalid block linkage or hashes"

        if not probe.is_valid_state():
            return False, "Invalid on-chain state transitions"

        return True, "valid"

    def adopt_chain(self, blocks: list[dict[str, Any]]) -> dict[str, Any]:
        ok, reason = self.verify_remote_chain(blocks)
        if not ok:
            self.last_error = reason
            return {"ok": False, "error": reason, "rejected": True}

        local = get_chain()
        if len(blocks) < len(local.chain):
            return {
                "ok": True,
                "action": "noop",
                "local_length": len(local.chain),
                "remote_length": len(blocks),
            }
        if len(blocks) == len(local.chain):
            if blocks and local.chain and blocks[-1].get("hash") != local.last_block.hash and len(local.chain) == 1:
                local.replace_chain(blocks)
                self.last_sync = time.time()
                self.last_error = None
                self.last_result = {
                    "ok": True,
                    "action": "replaced",
                    "length": len(blocks),
                    "state_root": state_root(rebuild_state_from_chain(blocks)),
                }
                self._save_meta()
                return self.last_result
            return {
                "ok": True,
                "action": "noop",
                "local_length": len(local.chain),
                "remote_length": len(blocks),
            }

        local.replace_chain(blocks)
        self.last_sync = time.time()
        self.last_error = None
        self.last_result = {
            "ok": True,
            "action": "adopted",
            "length": len(blocks),
            "state_root": state_root(rebuild_state_from_chain(blocks)),
        }
        self._save_meta()
        return self.last_result

    def verify_spv_balance(self, address: str) -> dict[str, Any]:
        try:
            proof = _api_get(self.hub_url, f"/api/wallet/proof?address={address}")
            from spv import verify_account_proof

            return {"ok": verify_account_proof(proof), "proof": proof}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def light_sync_once(self) -> dict[str, Any]:
        try:
            headers = self.fetch_remote_headers()
            local = get_chain()
            if len(headers) <= len(local.chain):
                return {"ok": True, "action": "noop", "mode": "light", "local_length": len(local.chain)}

            for index in range(len(local.chain), len(headers)):
                header = headers[index]
                previous = local.last_block
                if header.get("previous_hash") != previous.hash:
                    return {"ok": False, "error": "Header chain broken", "rejected": True}
                block = self.fetch_block(index)
                extended = [item.to_dict() for item in local.chain] + [block]
                probe = InferenceBlockchain()
                probe.chain = probe._blocks_from_payload(extended)
                if not probe.is_valid_structure() or not probe.is_valid_state():
                    return {"ok": False, "error": f"Invalid block #{index}", "rejected": True}
                local.chain = probe.chain
                local._save()

            self.last_sync = time.time()
            self.last_result = {"ok": True, "action": "light_adopted", "length": len(local.chain), "mode": "light"}
            self._save_meta()
            return self.last_result
        except Exception as exc:
            self.last_error = str(exc)
            return {"ok": False, "error": self.last_error}

    def sync_once(self) -> dict[str, Any]:
        if self.light:
            return self.light_sync_once()
        try:
            remote_blocks = self.fetch_remote_blocks()
            result = self.adopt_chain(remote_blocks)
            if result.get("ok") and result.get("action") == "adopted":
                self.push_if_longer()
            return result
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            self.last_error = f"HTTP {exc.code}: {detail}"
            return {"ok": False, "error": self.last_error}
        except Exception as exc:
            self.last_error = str(exc)
            return {"ok": False, "error": self.last_error}

    def push_if_longer(self) -> dict[str, Any]:
        local = get_chain()
        try:
            payload = {
                "blocks": [block.to_dict() for block in local.chain],
                "length": len(local.chain),
            }
            return _api_post(self.hub_url, "/api/chain/sync", payload)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def start_background(self, interval: float = 30.0) -> None:
        if self._thread and self._thread.is_alive():
            return

        def _loop() -> None:
            while not self._stop.wait(interval):
                self.sync_once()

        self._thread = threading.Thread(target=_loop, daemon=True, name="chain-sync")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _save_meta(self) -> None:
        SYNC_META_PATH.parent.mkdir(parents=True, exist_ok=True)
        SYNC_META_PATH.write_text(
            json.dumps(
                {
                    "hub_url": self.hub_url,
                    "last_sync": self.last_sync,
                    "last_result": self.last_result,
                    "chain_path": str(CHAIN_PATH),
                },
                indent=2,
            )
        )

    def snapshot(self) -> dict[str, Any]:
        local = get_chain()
        return {
            "hub_url": self.hub_url,
            "mode": "light" if self.light else "full",
            "local_length": len(local.chain),
            "valid": local.is_valid_structure() and local.is_valid_state(),
            "last_sync": self.last_sync,
            "last_error": self.last_error,
            "last_result": self.last_result,
        }
