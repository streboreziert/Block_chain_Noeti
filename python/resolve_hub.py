#!/usr/bin/env python3
"""Resolve the network entry point URL."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT = "http://127.0.0.1:5052"


def resolve_hub(hub: str | None = None) -> str:
    if hub and hub.strip() and hub.rstrip("/") != DEFAULT:
        return hub.rstrip("/")

    config_path = ROOT / "entrypoint.json"
    if config_path.exists():
        config = json.loads(config_path.read_text())
        public = config.get("public_url", "").strip()
        if public:
            return public.rstrip("/")

    for base in (DEFAULT,):
        try:
            with urllib.request.urlopen(f"{base}/api/entry", timeout=2) as resp:
                data = json.loads(resp.read().decode())
                return data.get("hub_url", DEFAULT).rstrip("/")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError):
            pass

    return DEFAULT
