"""Synced chat history for signed-in Noeti users."""
from __future__ import annotations

import json
import time
from pathlib import Path
from threading import Lock
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "connection-layer" / "data"
HISTORY_PATH = DATA_DIR / "chat_history.json"
_lock = Lock()


def _ensure() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _read() -> dict[str, Any]:
    if not HISTORY_PATH.exists():
        return {"users": {}}
    try:
        return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"users": {}}


def _write(data: dict[str, Any]) -> None:
    _ensure()
    tmp = HISTORY_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(HISTORY_PATH)


def get_history(username: str) -> dict[str, Any]:
    with _lock:
        data = _read()
        row = (data.get("users") or {}).get(username) or {"chats": [], "updated_at": None}
    chats = row.get("chats") or []
    return {"ok": True, "chats": chats, "updated_at": row.get("updated_at"), "count": len(chats)}


def save_history(username: str, chats: list[dict]) -> dict[str, Any]:
    if not isinstance(chats, list):
        return {"ok": False, "error": "bad_request", "message": "chats must be a list"}
    # Cap size
    cleaned = []
    for c in chats[:80]:
        if not isinstance(c, dict):
            continue
        msgs = c.get("messages") or []
        if not isinstance(msgs, list):
            msgs = []
        cleaned.append(
            {
                "id": str(c.get("id") or "")[:64],
                "title": str(c.get("title") or "Chat")[:120],
                "model": str(c.get("model") or "")[:120],
                "assistant_id": str(c.get("assistant_id") or "")[:64],
                "updated": c.get("updated") or time.time() * 1000,
                "messages": [
                    {
                        "role": m.get("role"),
                        "content": str(m.get("content") or "")[:20000],
                        "meta": m.get("meta"),
                    }
                    for m in msgs[-60:]
                    if isinstance(m, dict) and m.get("role") in ("user", "assistant")
                ],
            }
        )
    with _lock:
        data = _read()
        users = data.setdefault("users", {})
        users[username] = {"chats": cleaned, "updated_at": time.time()}
        _write(data)
    return {"ok": True, "count": len(cleaned), "updated_at": time.time()}
