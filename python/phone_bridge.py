#!/usr/bin/env python3
"""Phone → Canvas bridge: photo push + live WebRTC signaling.

Phone opens /phone?s=…&t=…
- Snap photo → inbox (Where=Phone)
- Go live → WebRTC offer/answer/ICE via short-lived signal queues
"""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any

_LOCK = threading.Lock()
_SESSIONS: dict[str, dict[str, Any]] = {}
TTL_SEC = 45 * 60
MAX_IMAGE_CHARS = 2_500_000
MAX_SIGNAL_QUEUE = 80


def _purge(now: float | None = None) -> None:
    t = now if now is not None else time.time()
    dead = [sid for sid, s in _SESSIONS.items() if float(s.get("expires") or 0) < t]
    for sid in dead:
        _SESSIONS.pop(sid, None)


def create_session(*, owner: str = "", label: str = "Phone") -> dict[str, Any]:
    with _LOCK:
        _purge()
        sid = f"ph_{secrets.token_hex(4)}"
        token = secrets.token_urlsafe(18)
        now = time.time()
        row = {
            "id": sid,
            "token": token,
            "owner": (owner or "")[:80],
            "label": (label or "Phone")[:60],
            "created": now,
            "expires": now + TTL_SEC,
            "last_seen": None,
            "device": None,
            "inbox": [],
            "pushed": 0,
            "live": False,
            "live_frame": None,
            "live_frame_at": 0,
            "commands": [],
            "signals_to_desktop": [],
            "signals_to_phone": [],
        }
        _SESSIONS[sid] = row
        return {
            "ok": True,
            "session_id": sid,
            "token": token,
            "expires_in": TTL_SEC,
            "label": row["label"],
            "pair_path": f"/phone?s={sid}&t={token}",
        }


def _get(session_id: str, token: str | None = None, *, require_token: bool = False) -> dict[str, Any] | None:
    _purge()
    row = _SESSIONS.get(session_id)
    if not row:
        return None
    if require_token or token:
        if not token or not secrets.compare_digest(str(row.get("token") or ""), str(token)):
            return None
    return row


def session_status(session_id: str, token: str | None = None) -> dict[str, Any]:
    with _LOCK:
        row = _get(session_id, token, require_token=bool(token))
        if not row:
            row = _SESSIONS.get(session_id)
            if not row:
                return {"ok": False, "error": "not_found", "message": "Phone session expired or missing"}
        pending = [x for x in row["inbox"] if not x.get("consumed")]
        cmds = list(row.get("commands") or [])
        row["commands"] = []
        return {
            "ok": True,
            "session_id": row["id"],
            "label": row["label"],
            "expires_in": max(0, int(row["expires"] - time.time())),
            "device": row.get("device"),
            "last_seen": row.get("last_seen"),
            "pushed": row.get("pushed") or 0,
            "live": bool(row.get("live")),
            "live_frame": row.get("live_frame") or "",
            "live_frame_at": row.get("live_frame_at") or 0,
            "commands": cmds,
            "pending": len(pending),
            "items": [
                {
                    "id": x["id"],
                    "kind": x.get("kind") or "capture",
                    "text": x.get("text") or "",
                    "image": x.get("image") or "",
                    "at": x.get("at"),
                    "device": x.get("device") or row.get("device"),
                }
                for x in pending[:8]
            ],
            "pair_path": f"/phone?s={row['id']}&t={row['token']}",
        }


def push_capture(
    session_id: str,
    token: str,
    *,
    image: str = "",
    text: str = "",
    device: str = "",
    kind: str = "",
) -> dict[str, Any]:
    img = (image or "").strip()
    note = (text or "").strip()[:2000]
    mode = (kind or "").strip().lower()
    if mode == "live_frame":
        if not img or not img.startswith("data:image/") or len(img) > MAX_IMAGE_CHARS:
            return {"ok": False, "error": "bad_image", "message": "Live frame invalid"}
        with _LOCK:
            row = _get(session_id, token, require_token=True)
            if not row:
                return {"ok": False, "error": "not_found", "message": "Session expired — pair again from Canvas"}
            row["live_frame"] = img
            row["live_frame_at"] = time.time()
            row["live"] = True
            row["last_seen"] = time.time()
            if device:
                row["device"] = device[:80]
            return {"ok": True, "kind": "live_frame", "live": True, "message": "Live frame"}
    if not img and not note:
        return {"ok": False, "error": "empty", "message": "Snap a photo or type a short note"}
    if img and (not img.startswith("data:image/") or len(img) > MAX_IMAGE_CHARS):
        return {"ok": False, "error": "bad_image", "message": "Image too large or invalid"}
    with _LOCK:
        row = _get(session_id, token, require_token=True)
        if not row:
            return {"ok": False, "error": "not_found", "message": "Session expired — pair again from Canvas"}
        item = {
            "id": f"cap_{secrets.token_hex(3)}",
            "kind": "image" if img else "note",
            "image": img,
            "text": note,
            "device": (device or row.get("device") or "Phone")[:80],
            "at": time.time(),
            "consumed": False,
        }
        row["inbox"] = [x for x in row["inbox"] if not x.get("consumed")][-20:]
        row["inbox"].append(item)
        row["pushed"] = int(row.get("pushed") or 0) + 1
        row["last_seen"] = time.time()
        if device:
            row["device"] = device[:80]
        return {
            "ok": True,
            "item_id": item["id"],
            "kind": item["kind"],
            "pending": len([x for x in row["inbox"] if not x.get("consumed")]),
            "message": "Sent to Canvas",
        }


def post_command(session_id: str, token: str, command: str, *, payload: Any = None) -> dict[str, Any]:
    """Phone → desktop remote controls (run / seal / freeze / vision)."""
    cmd = (command or "").strip().lower()
    if cmd not in ("run", "seal", "freeze", "vision", "hangup"):
        return {"ok": False, "error": "bad_command", "message": "Unknown command"}
    with _LOCK:
        row = _get(session_id, token, require_token=True)
        if not row:
            return {"ok": False, "error": "not_found", "message": "Session expired"}
        q = row.setdefault("commands", [])
        q.append({"id": f"cmd_{secrets.token_hex(3)}", "command": cmd, "payload": payload, "at": time.time()})
        row["commands"] = q[-20:]
        row["last_seen"] = time.time()
        if cmd == "hangup":
            row["live"] = False
            row["live_frame"] = None
        return {"ok": True, "queued": True, "command": cmd}


def ack_items(session_id: str, item_ids: list[str]) -> dict[str, Any]:
    with _LOCK:
        row = _SESSIONS.get(session_id)
        if not row:
            return {"ok": False, "error": "not_found"}
        wanted = set(item_ids or [])
        n = 0
        for x in row["inbox"]:
            if x.get("id") in wanted and not x.get("consumed"):
                x["consumed"] = True
                n += 1
        return {"ok": True, "acked": n}


def touch_phone(session_id: str, token: str, *, device: str = "") -> dict[str, Any]:
    with _LOCK:
        row = _get(session_id, token, require_token=True)
        if not row:
            return {"ok": False, "error": "not_found", "message": "Session expired"}
        row["last_seen"] = time.time()
        if device:
            row["device"] = device[:80]
        return {
            "ok": True,
            "session_id": row["id"],
            "label": row["label"],
            "expires_in": max(0, int(row["expires"] - time.time())),
            "device": row.get("device"),
            "live": bool(row.get("live")),
        }


def post_signal(
    session_id: str,
    token: str | None,
    *,
    from_role: str,
    msg_type: str,
    payload: Any = None,
    require_token: bool = False,
) -> dict[str, Any]:
    """from_role: phone | desktop. Message is queued for the other side."""
    role = (from_role or "").strip().lower()
    if role not in ("phone", "desktop"):
        return {"ok": False, "error": "bad_role", "message": "from_role must be phone or desktop"}
    kind = (msg_type or "").strip().lower()
    if kind not in ("offer", "answer", "ice", "hangup", "ready"):
        return {"ok": False, "error": "bad_type", "message": "Unknown signal type"}
    with _LOCK:
        row = _get(session_id, token, require_token=require_token or role == "phone")
        if not row:
            # Desktop may post with session id only (auth checked by API)
            row = _SESSIONS.get(session_id) if role == "desktop" and not require_token else None
            if not row:
                return {"ok": False, "error": "not_found", "message": "Session expired"}
        msg = {
            "id": f"sig_{secrets.token_hex(3)}",
            "type": kind,
            "payload": payload,
            "at": time.time(),
            "from": role,
        }
        key = "signals_to_desktop" if role == "phone" else "signals_to_phone"
        q = row.setdefault(key, [])
        q.append(msg)
        row[key] = q[-MAX_SIGNAL_QUEUE:]
        row["last_seen"] = time.time()
        if kind in ("offer", "ready"):
            row["live"] = True
        if kind == "hangup":
            row["live"] = False
        return {"ok": True, "queued": True, "live": bool(row.get("live"))}


def pull_signals(
    session_id: str,
    *,
    for_role: str,
    token: str | None = None,
    require_token: bool = False,
) -> dict[str, Any]:
    role = (for_role or "").strip().lower()
    if role not in ("phone", "desktop"):
        return {"ok": False, "error": "bad_role"}
    with _LOCK:
        row = _get(session_id, token, require_token=require_token or role == "phone")
        if not row:
            row = _SESSIONS.get(session_id) if role == "desktop" and not require_token else None
            if not row:
                return {"ok": False, "error": "not_found", "message": "Session expired"}
        key = "signals_to_phone" if role == "phone" else "signals_to_desktop"
        items = list(row.get(key) or [])
        row[key] = []
        return {
            "ok": True,
            "session_id": row["id"],
            "live": bool(row.get("live")),
            "device": row.get("device"),
            "signals": items,
        }


def set_live(session_id: str, live: bool) -> dict[str, Any]:
    with _LOCK:
        row = _SESSIONS.get(session_id)
        if not row:
            return {"ok": False, "error": "not_found"}
        row["live"] = bool(live)
        return {"ok": True, "live": row["live"]}
