#!/usr/bin/env python3
"""Easy PC ↔ Canvas device bridge.

Pair a home/office PC with a token link. The local agent heartbeats,
claims inference jobs, runs them on the machine's Ollama, and returns
results. Canvas routes Where=Specific PC / device jobs here.
"""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any

_LOCK = threading.Lock()
_SESSIONS: dict[str, dict[str, Any]] = {}
TTL_SEC = 6 * 60 * 60  # long-lived device links
ONLINE_SEC = 20
MAX_JOBS = 40


def _purge(now: float | None = None) -> None:
    t = now if now is not None else time.time()
    dead = [sid for sid, s in _SESSIONS.items() if float(s.get("expires") or 0) < t]
    for sid in dead:
        _SESSIONS.pop(sid, None)


def create_session(*, owner: str = "", label: str = "My PC") -> dict[str, Any]:
    with _LOCK:
        _purge()
        sid = f"dev_{secrets.token_hex(4)}"
        token = secrets.token_urlsafe(18)
        device_id = f"pc-{secrets.token_hex(3)}"
        now = time.time()
        row = {
            "id": sid,
            "token": token,
            "device_id": device_id,
            "owner": (owner or "")[:80],
            "label": (label or "My PC")[:60],
            "created": now,
            "expires": now + TTL_SEC,
            "last_seen": None,
            "online": False,
            "models": [],
            "ollama": False,
            "hostname": "",
            "platform": "",
            "jobs": [],
            "results": {},
        }
        _SESSIONS[sid] = row
        return {
            "ok": True,
            "session_id": sid,
            "token": token,
            "device_id": device_id,
            "label": row["label"],
            "expires_in": TTL_SEC,
            "pair_path": f"/device?s={sid}&t={token}",
            "agent_cmd": f"curl -sSL https://noeticompute.com/device-agent.sh | bash -s -- {sid} {token}",
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


def _is_online(row: dict[str, Any], now: float | None = None) -> bool:
    t = now if now is not None else time.time()
    seen = float(row.get("last_seen") or 0)
    return bool(seen and (t - seen) <= ONLINE_SEC)


def list_devices(*, owner: str = "") -> dict[str, Any]:
    with _LOCK:
        _purge()
        now = time.time()
        out = []
        for row in _SESSIONS.values():
            if owner and row.get("owner") and row.get("owner") != owner:
                continue
            online = _is_online(row, now)
            row["online"] = online
            out.append(
                {
                    "session_id": row["id"],
                    "device_id": row["device_id"],
                    "label": row["label"],
                    "online": online,
                    "models": list(row.get("models") or [])[:24],
                    "ollama": bool(row.get("ollama")),
                    "hostname": row.get("hostname") or "",
                    "platform": row.get("platform") or "",
                    "last_seen": row.get("last_seen"),
                    "pending_jobs": len([j for j in row.get("jobs") or [] if j.get("status") == "queued"]),
                }
            )
        out.sort(key=lambda x: (not x["online"], x["label"].lower()))
        return {"ok": True, "devices": out}


def session_status(session_id: str, token: str | None = None) -> dict[str, Any]:
    with _LOCK:
        row = _get(session_id, token, require_token=bool(token))
        if not row:
            row = _SESSIONS.get(session_id)
            if not row:
                return {"ok": False, "error": "not_found", "message": "Device session expired"}
        now = time.time()
        online = _is_online(row, now)
        row["online"] = online
        return {
            "ok": True,
            "session_id": row["id"],
            "device_id": row["device_id"],
            "label": row["label"],
            "online": online,
            "models": list(row.get("models") or [])[:24],
            "ollama": bool(row.get("ollama")),
            "hostname": row.get("hostname") or "",
            "platform": row.get("platform") or "",
            "last_seen": row.get("last_seen"),
            "expires_in": max(0, int(row["expires"] - now)),
            "pair_path": f"/device?s={row['id']}&t={row['token']}",
        }


def heartbeat(
    session_id: str,
    token: str,
    *,
    models: list[str] | None = None,
    ollama: bool = False,
    hostname: str = "",
    platform: str = "",
    label: str = "",
) -> dict[str, Any]:
    with _LOCK:
        row = _get(session_id, token, require_token=True)
        if not row:
            return {"ok": False, "error": "not_found", "message": "Session expired — pair again from Canvas"}
        row["last_seen"] = time.time()
        row["online"] = True
        row["ollama"] = bool(ollama)
        if models is not None:
            row["models"] = [str(m)[:80] for m in models if m][:40]
        if hostname:
            row["hostname"] = hostname[:80]
        if platform:
            row["platform"] = platform[:80]
        if label:
            row["label"] = label[:60]
        return {
            "ok": True,
            "device_id": row["device_id"],
            "label": row["label"],
            "pending_jobs": len([j for j in row.get("jobs") or [] if j.get("status") == "queued"]),
        }


def enqueue_job(
    session_id: str,
    *,
    messages: list[dict[str, Any]] | None = None,
    prompt: str = "",
    model: str = "",
    temperature: float = 0.55,
    meta: dict[str, Any] | None = None,
    kind: str = "infer",
    script: dict[str, Any] | None = None,
) -> dict[str, Any]:
    with _LOCK:
        row = _SESSIONS.get(session_id)
        if not row:
            return {"ok": False, "error": "not_found", "message": "Device not paired"}
        if not _is_online(row):
            return {"ok": False, "error": "offline", "message": "Device offline — start the agent on that PC"}
        job_id = f"job_{secrets.token_hex(4)}"
        job = {
            "id": job_id,
            "status": "queued",
            "created": time.time(),
            "kind": (kind or "infer")[:20],
            "messages": messages or [],
            "prompt": (prompt or "")[:12000],
            "model": (model or "")[:120],
            "temperature": float(temperature or 0.55),
            "meta": meta or {},
            "script": script if isinstance(script, dict) else None,
        }
        jobs = row.setdefault("jobs", [])
        jobs.append(job)
        row["jobs"] = jobs[-MAX_JOBS:]
        return {
            "ok": True,
            "job_id": job_id,
            "device_id": row["device_id"],
            "label": row["label"],
            "session_id": row["id"],
        }


def claim_job(session_id: str, token: str) -> dict[str, Any]:
    with _LOCK:
        row = _get(session_id, token, require_token=True)
        if not row:
            return {"ok": False, "error": "not_found"}
        row["last_seen"] = time.time()
        row["online"] = True
        for job in row.get("jobs") or []:
            if job.get("status") == "queued":
                job["status"] = "running"
                job["claimed_at"] = time.time()
                return {"ok": True, "job": dict(job), "device_id": row["device_id"]}
        return {"ok": True, "job": None, "device_id": row["device_id"]}


def submit_result(
    session_id: str,
    token: str,
    *,
    job_id: str,
    reply: str = "",
    model: str = "",
    ok: bool = True,
    error: str = "",
    latency_ms: int | None = None,
    output: str = "",
    explain: str = "",
    metrics: dict[str, Any] | None = None,
    kind: str = "",
) -> dict[str, Any]:
    with _LOCK:
        row = _get(session_id, token, require_token=True)
        if not row:
            return {"ok": False, "error": "not_found"}
        found = None
        for job in row.get("jobs") or []:
            if job.get("id") == job_id:
                found = job
                break
        if not found:
            return {"ok": False, "error": "job_not_found"}
        found["status"] = "done" if ok else "error"
        result = {
            "job_id": job_id,
            "ok": bool(ok),
            "kind": kind or found.get("kind") or "infer",
            "reply": (reply or output or "")[:50000],
            "output": (output or reply or "")[:50000],
            "explain": (explain or "")[:4000],
            "metrics": metrics if isinstance(metrics, dict) else {},
            "model": (model or found.get("model") or "")[:120],
            "error": (error or "")[:500],
            "message": (error or "")[:500],
            "latency_ms": latency_ms,
            "device_id": row["device_id"],
            "label": row["label"],
            "where": f"PC · {row.get('label') or row.get('hostname') or row['device_id']}",
            "at": time.time(),
        }
        row.setdefault("results", {})[job_id] = result
        row["last_seen"] = time.time()
        return {"ok": True, "job_id": job_id}


def get_result(session_id: str, job_id: str) -> dict[str, Any]:
    with _LOCK:
        row = _SESSIONS.get(session_id)
        if not row:
            return {"ok": False, "error": "not_found"}
        result = (row.get("results") or {}).get(job_id)
        if not result:
            # still running?
            for job in row.get("jobs") or []:
                if job.get("id") == job_id:
                    return {
                        "ok": True,
                        "ready": False,
                        "status": job.get("status") or "queued",
                        "job_id": job_id,
                        "online": _is_online(row),
                    }
            return {"ok": False, "error": "job_not_found"}
        return {"ok": True, "ready": True, **result}


def find_session_for_device(device_id: str) -> dict[str, Any] | None:
    with _LOCK:
        _purge()
        for row in _SESSIONS.values():
            if row.get("device_id") == device_id:
                return row
        return None


def enqueue_for_device(
    device_id: str,
    *,
    messages: list[dict[str, Any]] | None = None,
    prompt: str = "",
    model: str = "",
    temperature: float = 0.55,
    meta: dict[str, Any] | None = None,
    kind: str = "infer",
    script: dict[str, Any] | None = None,
) -> dict[str, Any]:
    row = find_session_for_device(device_id)
    if not row:
        return {"ok": False, "error": "not_found", "message": "Unknown device — pair it from Canvas"}
    return enqueue_job(
        row["id"],
        messages=messages,
        prompt=prompt,
        model=model,
        temperature=temperature,
        meta=meta,
        kind=kind,
        script=script,
    )


def first_online_device(owner: str = "") -> dict[str, Any] | None:
    devices = list_devices(owner=owner).get("devices") or []
    for d in devices:
        if d.get("online"):
            return d
    return None
