"""Network entry point — public bootstrap URL and hub discovery."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

CONFIG_PATH = Path(__file__).resolve().parent.parent / "entrypoint.json"
REGISTRY_PATH = Path(__file__).resolve().parent / "data" / "entry_registry.json"


def _load_config() -> dict[str, Any]:
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text())
    return {"network_name": "Noeti Mainnet", "public_url": "", "description": ""}


def _load_registry() -> dict[str, Any]:
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text())
    return {"hubs": []}


def _save_registry(data: dict[str, Any]) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(data, indent=2))


def register_hub(hub_url: str, *, name: str = "hub", lan_url: str = "") -> dict[str, Any]:
    hub_url = hub_url.rstrip("/")
    entry = {
        "hub_url": hub_url,
        "lan_url": lan_url.rstrip("/") if lan_url else hub_url,
        "name": name,
        "registered_at": time.time(),
        "last_seen": time.time(),
    }
    store = _load_registry()
    hubs = [h for h in store.get("hubs", []) if h.get("hub_url") != hub_url]
    hubs.insert(0, entry)
    store["hubs"] = hubs[:20]
    _save_registry(store)
    return entry


def discover(*, request_url: str = "", lan_url: str = "") -> dict[str, Any]:
    config = _load_config()
    store = _load_registry()
    hubs = store.get("hubs", [])

    hub_url = (
        config.get("public_url", "").rstrip("/")
        or (hubs[0]["hub_url"] if hubs else "")
        or request_url.rstrip("/")
        or lan_url.rstrip("/")
    )

    if not hub_url:
        hub_url = "http://127.0.0.1:5052"

    return {
        "network_name": config.get("network_name", "Noeti Mainnet"),
        "description": config.get("description", ""),
        "entry_url": hub_url,
        "hub_url": hub_url,
        "join_url": hub_url,
        "registered_hubs": len(hubs),
        "local_app_command": f"python3 launch.py user --hub {hub_url} --open",
        "join_commands": {
            "user": f"python3 launch.py user --hub {hub_url} --open",
            "relay": f"python3 launch.py relay --hub {hub_url} --id my-relay",
            "compute": f"python3 launch.py compute --hub {hub_url} --id my-gpu",
        },
        "flow": "user → entry point → relay → compute",
    }


def snapshot(request_url: str = "", lan_url: str = "") -> dict[str, Any]:
    info = discover(request_url=request_url, lan_url=lan_url)
    store = _load_registry()
    info["hubs"] = store.get("hubs", [])[:5]
    return info
