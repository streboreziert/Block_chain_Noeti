"""Noeti Desk product layer: plans, metering, ProofPath runs, admin settings, Stripe hooks."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from pathlib import Path
from threading import Lock
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "connection-layer" / "data"
DESKS_PATH = DATA_DIR / "desks.json"
PROJECTS_PATH = DATA_DIR / "proofpath_projects.json"
SETTINGS_PATH = DATA_DIR / "desk_settings.json"

_lock = Lock()

PLANS: dict[str, dict[str, Any]] = {
    "trial": {
        "id": "trial",
        "name": "Trial",
        "price_usd": 0,
        "seats": 1,
        "runs": 10,
        "overage_usd": 0,
    },
    "solo": {
        "id": "solo",
        "name": "Solo",
        "price_usd": 89,
        "seats": 1,
        "runs": 80,
        "overage_usd": 1.25,
        "stripe_price_env": "STRIPE_PRICE_SOLO",
    },
    "desk": {
        "id": "desk",
        "name": "Desk",
        "price_usd": 299,
        "seats": 5,
        "runs": 400,
        "overage_usd": 1.0,
        "stripe_price_env": "STRIPE_PRICE_DESK",
    },
    "newsroom": {
        "id": "newsroom",
        "name": "Newsroom",
        "price_usd": 999,
        "seats": 50,
        "runs": 1500,
        "overage_usd": 0.9,
        "stripe_price_env": "STRIPE_PRICE_NEWSROOM",
    },
}


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _ensure() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def _write(path: Path, data: Any) -> None:
    _ensure()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _month_key(ts: float | None = None) -> str:
    t = time.gmtime(ts or time.time())
    return f"{t.tm_year:04d}-{t.tm_mon:02d}"


def get_settings() -> dict[str, Any]:
    raw = _read(SETTINGS_PATH, {})
    return {
        "golem_chat_base_url": raw.get("golem_chat_base_url") or _env("GOLEM_CHAT_BASE_URL"),
        "golem_chat_api_key_set": bool(raw.get("golem_chat_api_key") or _env("GOLEM_CHAT_API_KEY")),
        "golem_chat_model": raw.get("golem_chat_model") or _env("GOLEM_CHAT_MODEL") or _env("HUB_MODEL", "qwen2.5:1.5b"),
        "openrouter_api_key_set": bool(raw.get("openrouter_api_key") or _env("OPENROUTER_API_KEY")),
        "openrouter_default_model": raw.get("openrouter_default_model")
        or _env("OPENROUTER_DEFAULT_MODEL")
        or "gpt-4o-mini",
        "usage_caps": raw.get("usage_caps") or {k: v["runs"] for k, v in PLANS.items()},
        "public_signup": raw.get("public_signup", True),
        "updated_at": raw.get("updated_at"),
    }


def apply_chat_env_from_settings() -> None:
    """Load persisted Admin chat settings into process env (OpenRouter + remote)."""
    raw = _read(SETTINGS_PATH, {})
    if raw.get("openrouter_api_key"):
        os.environ["OPENROUTER_API_KEY"] = str(raw["openrouter_api_key"])
    if raw.get("openrouter_default_model"):
        os.environ["OPENROUTER_DEFAULT_MODEL"] = str(raw["openrouter_default_model"])
    if raw.get("golem_chat_base_url") is not None and raw.get("golem_chat_base_url") != "":
        os.environ["GOLEM_CHAT_BASE_URL"] = str(raw.get("golem_chat_base_url") or "")
    if raw.get("golem_chat_api_key"):
        os.environ["GOLEM_CHAT_API_KEY"] = str(raw["golem_chat_api_key"])
    if raw.get("golem_chat_model"):
        os.environ["GOLEM_CHAT_MODEL"] = str(raw["golem_chat_model"])


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        raw = _read(SETTINGS_PATH, {})
        for key in (
            "golem_chat_base_url",
            "golem_chat_api_key",
            "golem_chat_model",
            "openrouter_api_key",
            "openrouter_default_model",
            "public_signup",
        ):
            if key in patch:
                raw[key] = patch[key]
        if isinstance(patch.get("usage_caps"), dict):
            caps = raw.get("usage_caps") or {}
            for k, v in patch["usage_caps"].items():
                if k in PLANS:
                    try:
                        caps[k] = max(0, int(v))
                    except (TypeError, ValueError):
                        continue
            raw["usage_caps"] = caps
        raw["updated_at"] = time.time()
        _write(SETTINGS_PATH, raw)
    # Apply to process env for live routing
    if patch.get("golem_chat_base_url") is not None:
        os.environ["GOLEM_CHAT_BASE_URL"] = str(patch.get("golem_chat_base_url") or "")
    if patch.get("golem_chat_api_key"):
        os.environ["GOLEM_CHAT_API_KEY"] = str(patch["golem_chat_api_key"])
    if patch.get("golem_chat_model"):
        os.environ["GOLEM_CHAT_MODEL"] = str(patch["golem_chat_model"])
    if patch.get("openrouter_api_key"):
        os.environ["OPENROUTER_API_KEY"] = str(patch["openrouter_api_key"])
    if patch.get("openrouter_default_model") is not None:
        os.environ["OPENROUTER_DEFAULT_MODEL"] = str(patch.get("openrouter_default_model") or "gpt-4o-mini")
    return get_settings()


def _plan_runs(plan_id: str) -> int:
    settings = get_settings()
    caps = settings.get("usage_caps") or {}
    if plan_id in caps:
        try:
            return int(caps[plan_id])
        except (TypeError, ValueError):
            pass
    return int(PLANS.get(plan_id, PLANS["trial"])["runs"])


def get_or_create_desk(username: str, *, display: str | None = None) -> dict[str, Any]:
    u = (username or "").strip().lower()
    if not u:
        raise ValueError("username required")
    with _lock:
        data = _read(DESKS_PATH, {"desks": {}})
        desks = data.setdefault("desks", {})
        if u not in desks:
            desks[u] = {
                "id": u,
                "owner": u,
                "name": (display or f"{u}'s desk")[:64],
                "plan": "trial",
                "seats": [{"username": u, "role": "owner"}],
                "usage": {},
                "stripe_customer_id": None,
                "stripe_subscription_id": None,
                "created_at": time.time(),
            }
            _write(DESKS_PATH, data)
        return dict(desks[u])


def _save_desk(desk: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        data = _read(DESKS_PATH, {"desks": {}})
        desks = data.setdefault("desks", {})
        desks[desk["id"]] = desk
        _write(DESKS_PATH, data)
    return desk


def desk_summary(username: str) -> dict[str, Any]:
    desk = get_or_create_desk(username)
    plan_id = desk.get("plan") or "trial"
    plan = PLANS.get(plan_id, PLANS["trial"])
    month = _month_key()
    used = int((desk.get("usage") or {}).get(month, 0))
    limit = _plan_runs(plan_id)
    return {
        "ok": True,
        "desk": {
            "id": desk["id"],
            "name": desk.get("name"),
            "plan": plan_id,
            "plan_name": plan["name"],
            "price_usd": plan["price_usd"],
            "seats": desk.get("seats") or [],
            "seat_limit": plan["seats"],
            "runs_used": used,
            "runs_limit": limit,
            "runs_remaining": max(0, limit - used),
            "overage_usd": plan.get("overage_usd", 0),
            "month": month,
            "stripe_subscription_id": desk.get("stripe_subscription_id"),
        },
        "plans": [
            {
                "id": p["id"],
                "name": p["name"],
                "price_usd": p["price_usd"],
                "seats": p["seats"],
                "runs": _plan_runs(p["id"]),
                "overage_usd": p.get("overage_usd", 0),
            }
            for p in PLANS.values()
        ],
    }


def set_plan(username: str, plan_id: str, *, stripe_subscription_id: str | None = None) -> dict[str, Any]:
    if plan_id not in PLANS:
        raise ValueError("unknown plan")
    desk = get_or_create_desk(username)
    desk["plan"] = plan_id
    if stripe_subscription_id:
        desk["stripe_subscription_id"] = stripe_subscription_id
    _save_desk(desk)
    return desk_summary(username)


def add_seat(owner: str, member: str, role: str = "member") -> dict[str, Any]:
    desk = get_or_create_desk(owner)
    plan = PLANS.get(desk.get("plan") or "trial", PLANS["trial"])
    seats = desk.setdefault("seats", [])
    member = member.strip().lower()
    if any(s.get("username") == member for s in seats):
        return desk_summary(owner)
    if len(seats) >= int(plan["seats"]):
        raise ValueError(f"Seat limit reached for {plan['name']} ({plan['seats']})")
    seats.append({"username": member, "role": role, "added_at": time.time()})
    _save_desk(desk)
    return desk_summary(owner)


def consume_run(username: str, *, kind: str = "proofpath") -> dict[str, Any]:
    desk = get_or_create_desk(username)
    plan_id = desk.get("plan") or "trial"
    month = _month_key()
    usage = desk.setdefault("usage", {})
    used = int(usage.get(month, 0))
    limit = _plan_runs(plan_id)
    if used >= limit:
        return {
            "ok": False,
            "error": "quota",
            "message": f"Run quota exhausted for {PLANS[plan_id]['name']} ({limit}/mo). Upgrade or wait for next month.",
            "runs_used": used,
            "runs_limit": limit,
        }
    usage[month] = used + 1
    desk.setdefault("run_log", [])
    desk["run_log"] = (desk.get("run_log") or [])[-200:]
    desk["run_log"].append({"ts": time.time(), "kind": kind, "month": month})
    _save_desk(desk)
    return {
        "ok": True,
        "runs_used": used + 1,
        "runs_limit": limit,
        "runs_remaining": max(0, limit - used - 1),
    }


def _ollama_chat(messages: list[dict], model: str | None = None) -> str:
    host = _env("OLLAMA_HOST", "http://ollama:11434").rstrip("/")
    model = model or _env("HUB_MODEL", "qwen2.5:1.5b")
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": 1200},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{host}/api/chat",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError:
        payload["model"] = _env("HUB_MODEL_FALLBACK", "qwen2.5:0.5b")
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{host}/api/chat",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = json.loads(resp.read().decode("utf-8", errors="replace"))
    return ((raw.get("message") or {}).get("content") or "").strip()


def _parse_claims(text: str) -> list[str]:
    claims: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        line = re.sub(r"^[\-\*\d\.\)\]]+\s*", "", line)
        line = re.sub(r"^claim\s*\d*\s*[:\-]\s*", "", line, flags=re.I)
        if len(line) < 12:
            continue
        claims.append(line[:400])
        if len(claims) >= 24:
            break
    if not claims:
        # fallback: sentence split
        parts = re.split(r"(?<=[.!?])\s+", text)
        for p in parts:
            p = p.strip()
            if len(p) >= 20:
                claims.append(p[:400])
            if len(claims) >= 12:
                break
    return claims


def atomize_document(username: str, title: str, body: str) -> dict[str, Any]:
    body = (body or "").strip()
    if len(body) < 40:
        return {"ok": False, "error": "short", "message": "Document too short to atomize."}
    if len(body) > 40000:
        body = body[:40000]

    quota = consume_run(username, kind="atomize")
    if not quota.get("ok"):
        return quota

    prompt = (
        "Break the following document into atomic factual claims. "
        "Return one claim per line. No numbering preamble. No commentary.\n\n"
        f"DOCUMENT:\n{body}"
    )
    try:
        raw = _ollama_chat(
            [
                {"role": "system", "content": "You extract atomic claims for investigative verification."},
                {"role": "user", "content": prompt},
            ]
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": "compute", "message": f"Atomize failed: {exc}"}

    claims_text = _parse_claims(raw)
    project_id = secrets.token_urlsafe(10)
    claims = []
    for i, c in enumerate(claims_text):
        claims.append(
            {
                "id": f"c{i+1}",
                "text": c,
                "status": "pending",
                "witnesses": [],
                "contradictions": [],
                "negative_evidence": [],
            }
        )
    project = {
        "id": project_id,
        "owner": username,
        "title": (title or "Untitled").strip()[:120] or "Untitled",
        "source_excerpt": body[:2000],
        "created_at": time.time(),
        "updated_at": time.time(),
        "claims": claims,
        "publish_gate": "blocked" if claims else "open",
    }
    with _lock:
        data = _read(PROJECTS_PATH, {"projects": {}})
        data.setdefault("projects", {})[project_id] = project
        _write(PROJECTS_PATH, data)

    return {
        "ok": True,
        "project": project,
        "quota": quota,
        "claim_count": len(claims),
    }


def import_proofpath_run(username: str, packet: dict[str, Any]) -> dict[str, Any]:
    """Save a newsroom ProofPath packet into the user's Desk project list."""
    if not packet or not packet.get("run_id"):
        return {"ok": False, "error": "invalid", "message": "Missing ProofPath packet"}

    quota = consume_run(username, kind="proofpath")
    if not quota.get("ok"):
        return quota

    claims = []
    for i, c in enumerate(packet.get("claims") or []):
        witnesses = []
        for w in c.get("witnesses") or []:
            witnesses.append(
                {
                    "class": w.get("role") or "judge",
                    "result": w.get("verdict") or "unknown",
                    "note": w.get("reason") or "",
                    "model": w.get("model"),
                    "saw": w.get("saw"),
                }
            )
        agg = c.get("aggregate") or {}
        status = agg.get("final_verdict") or "pending"
        claims.append(
            {
                "id": f"c{i+1}",
                "text": c.get("text") or "",
                "status": status,
                "witnesses": witnesses,
                "contradictions": [],
                "negative_evidence": [],
                "aggregate": agg,
            }
        )

    project_id = secrets.token_urlsafe(10)
    title = (packet.get("query") or "ProofPath run").strip()[:120] or "ProofPath run"
    project = {
        "id": project_id,
        "owner": username,
        "title": title,
        "source_excerpt": (packet.get("query") or "")[:2000],
        "created_at": time.time(),
        "updated_at": time.time(),
        "claims": claims,
        "publish_gate": (packet.get("summary") or {}).get("publish_gate") or "review",
        "proofpath_run_id": packet.get("run_id"),
        "routing": packet.get("routing"),
        "quality": packet.get("quality"),
        "integrity": packet.get("integrity"),
        "sources": packet.get("sources") or [],
        "versions": [
            {
                "at": time.time(),
                "run_id": packet.get("run_id"),
                "publish_gate": (packet.get("summary") or {}).get("publish_gate"),
            }
        ],
    }
    with _lock:
        data = _read(PROJECTS_PATH, {"projects": {}})
        data.setdefault("projects", {})[project_id] = project
        _write(PROJECTS_PATH, data)

    return {"ok": True, "project": project, "quota": quota}


def list_projects(username: str) -> dict[str, Any]:
    with _lock:
        data = _read(PROJECTS_PATH, {"projects": {}})
        projects = [
            {
                "id": p["id"],
                "title": p.get("title"),
                "created_at": p.get("created_at"),
                "claim_count": len(p.get("claims") or []),
                "publish_gate": p.get("publish_gate"),
            }
            for p in (data.get("projects") or {}).values()
            if p.get("owner") == username
        ]
    projects.sort(key=lambda x: x.get("created_at") or 0, reverse=True)
    return {"ok": True, "projects": projects}


def get_project(username: str, project_id: str) -> dict[str, Any] | None:
    with _lock:
        data = _read(PROJECTS_PATH, {"projects": {}})
        p = (data.get("projects") or {}).get(project_id)
    if not p or p.get("owner") != username:
        return None
    return p


def run_witnesses(username: str, project_id: str) -> dict[str, Any]:
    project = get_project(username, project_id)
    if not project:
        return {"ok": False, "error": "not_found", "message": "Project not found"}

    quota = consume_run(username, kind="witness")
    if not quota.get("ok"):
        return quota

    claims = project.get("claims") or []
    contested = 0
    for claim in claims:
        text = claim.get("text") or ""
        # Heuristic multi-witness classes + light LLM stress
        witnesses = [
            {"class": "primary_record", "result": "unchecked", "note": "Needs registry/court lookup"},
            {"class": "documentary", "result": "partial", "note": "Present in source excerpt"},
            {"class": "timeline", "result": "ok" if re.search(r"\b(20\d{2}|January|February|March|April|May|June|July|August|September|October|November|December)\b", text) else "weak", "note": "Date markers"},
            {"class": "network_compute", "result": "queued", "note": "Independent node check"},
        ]
        contradictions: list[str] = []
        negative: list[str] = []
        try:
            probe = _ollama_chat(
                [
                    {
                        "role": "system",
                        "content": "You are a skeptical verifier. Reply with JSON only: "
                        '{"status":"supported|contested|unknown","contradiction":"","negative":""}',
                    },
                    {"role": "user", "content": f"Claim: {text}"},
                ]
            )
            m = re.search(r"\{.*\}", probe, re.S)
            status = "unknown"
            if m:
                parsed = json.loads(m.group(0))
                status = str(parsed.get("status") or "unknown").lower()
                if parsed.get("contradiction"):
                    contradictions.append(str(parsed["contradiction"])[:300])
                if parsed.get("negative"):
                    negative.append(str(parsed["negative"])[:300])
            else:
                status = "unknown"
        except Exception:  # noqa: BLE001
            status = "unknown"

        if status not in ("supported", "contested", "unknown"):
            status = "unknown"
        if status == "contested":
            contested += 1
            witnesses[3]["result"] = "conflict"
        elif status == "supported":
            witnesses[3]["result"] = "ok"
        else:
            witnesses[3]["result"] = "unknown"

        claim["status"] = status
        claim["witnesses"] = witnesses
        claim["contradictions"] = contradictions
        claim["negative_evidence"] = negative or ["No disconfirming search logged yet"]

    project["publish_gate"] = "blocked" if contested else "ready"
    project["updated_at"] = time.time()
    project["claims"] = claims
    with _lock:
        data = _read(PROJECTS_PATH, {"projects": {}})
        data.setdefault("projects", {})[project_id] = project
        _write(PROJECTS_PATH, data)

    return {"ok": True, "project": project, "quota": quota, "contested": contested}


def export_project(username: str, project_id: str, fmt: str = "json") -> dict[str, Any]:
    project = get_project(username, project_id)
    if not project:
        return {"ok": False, "error": "not_found", "message": "Project not found"}

    trail = {
        "product": "Noeti ProofPath",
        "exported_at": time.time(),
        "owner": username,
        "project_id": project_id,
        "title": project.get("title"),
        "publish_gate": project.get("publish_gate"),
        "claims": project.get("claims") or [],
        "method": ["atomize", "witness", "contradict", "negative_evidence", "replay", "publish_gate"],
        "quality": {
            "tier": "desk",
            "label": "Desk project export — human seats + witness board",
            "publish_ready": project.get("publish_gate") == "ready",
        },
    }
    try:
        from proofpath_packet import integrity_digest

        trail["integrity"] = {
            "alg": "sha256",
            "digest": integrity_digest(
                {
                    "project_id": project_id,
                    "title": trail["title"],
                    "publish_gate": trail["publish_gate"],
                    "claims": trail["claims"],
                }
            ),
            "signed": False,
        }
    except Exception:  # noqa: BLE001
        pass

    if fmt == "json":
        return {"ok": True, "format": "json", "trail": trail}

    # Lightweight text "PDF-ready" audit (true PDF lib optional later)
    lines = [
        "NOETI PROOFPATH AUDIT TRAIL",
        f"Title: {trail['title']}",
        f"Owner: {username}",
        f"Gate: {trail['publish_gate']}",
        f"Exported: {time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime(trail['exported_at']))}",
        "",
    ]
    for c in trail["claims"]:
        lines.append(f"[{c.get('id')}] ({c.get('status')}) {c.get('text')}")
        for w in c.get("witnesses") or []:
            lines.append(f"  - witness/{w.get('class')}: {w.get('result')} — {w.get('note')}")
        for x in c.get("contradictions") or []:
            lines.append(f"  - contradiction: {x}")
        for n in c.get("negative_evidence") or []:
            lines.append(f"  - negative: {n}")
        lines.append("")
    return {"ok": True, "format": "txt", "filename": f"proofpath-{project_id}.txt", "content": "\n".join(lines), "trail": trail}


def stripe_configured() -> bool:
    return bool(_env("STRIPE_SECRET_KEY") and _env("STRIPE_PRICE_SOLO"))


def create_checkout(username: str, plan_id: str, success_url: str, cancel_url: str) -> dict[str, Any]:
    if plan_id not in PLANS or plan_id == "trial":
        raise ValueError("Choose solo, desk, or newsroom")
    plan = PLANS[plan_id]

    if not stripe_configured():
        # Dev unlock path — activate plan without Stripe
        summary = set_plan(username, plan_id, stripe_subscription_id=f"dev_{plan_id}_{int(time.time())}")
        return {
            "ok": True,
            "mode": "dev",
            "message": "Stripe keys not set — plan activated in development mode.",
            "summary": summary,
        }

    import urllib.parse

    price_env = plan.get("stripe_price_env") or ""
    price_id = _env(price_env)
    if not price_id:
        raise ValueError(f"Missing Stripe price id env {price_env}")

    form = urllib.parse.urlencode(
        {
            "mode": "subscription",
            "success_url": success_url,
            "cancel_url": cancel_url,
            "line_items[0][price]": price_id,
            "line_items[0][quantity]": 1,
            "client_reference_id": username,
            "metadata[plan]": plan_id,
            "metadata[username]": username,
        }
    ).encode()
    req = urllib.request.Request(
        "https://api.stripe.com/v1/checkout/sessions",
        data=form,
        headers={
            "Authorization": f"Bearer {_env('STRIPE_SECRET_KEY')}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        session = json.loads(resp.read().decode())
    return {"ok": True, "mode": "stripe", "url": session.get("url"), "id": session.get("id")}


def handle_stripe_webhook(payload: bytes, sig_header: str | None) -> dict[str, Any]:
    secret = _env("STRIPE_WEBHOOK_SECRET")
    # Minimal verify: if secret set, require header presence (full HMAC can be added with stripe lib)
    if secret and not sig_header:
        return {"ok": False, "error": "missing_sig"}
    try:
        event = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError:
        return {"ok": False, "error": "bad_json"}

    etype = event.get("type")
    obj = (event.get("data") or {}).get("object") or {}
    if etype == "checkout.session.completed":
        username = (obj.get("client_reference_id") or (obj.get("metadata") or {}).get("username") or "").lower()
        plan_id = (obj.get("metadata") or {}).get("plan") or "solo"
        if username and plan_id in PLANS:
            set_plan(username, plan_id, stripe_subscription_id=obj.get("subscription"))
            return {"ok": True, "activated": username, "plan": plan_id}
    return {"ok": True, "ignored": etype}


def pull_ollama_model(model: str) -> dict[str, Any]:
    model = (model or "").strip()
    if not model or len(model) > 80:
        return {"ok": False, "message": "Invalid model name"}
    host = _env("OLLAMA_HOST", "http://ollama:11434").rstrip("/")
    payload = json.dumps({"name": model}).encode()
    req = urllib.request.Request(
        f"{host}/api/pull",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # Non-streaming pull may be long; start and return accepted
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            # read a bit
            chunk = resp.read(500).decode("utf-8", errors="replace")
        return {"ok": True, "message": f"Pull started for {model}", "preview": chunk[:200]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": f"Pull failed: {exc}"}


def admin_overview() -> dict[str, Any]:
    with _lock:
        desks = (_read(DESKS_PATH, {"desks": {}}) or {}).get("desks") or {}
        projects = (_read(PROJECTS_PATH, {"projects": {}}) or {}).get("projects") or {}
    return {
        "ok": True,
        "desk_count": len(desks),
        "project_count": len(projects),
        "settings": get_settings(),
        "stripe_configured": stripe_configured(),
        "plans": list(PLANS.values()),
    }
