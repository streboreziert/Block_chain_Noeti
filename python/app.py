#!/usr/bin/env python3
"""Noetis network — host hub, user app, or join as compute."""

from __future__ import annotations

import argparse
import hmac
import os
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONNECTION = ROOT / "connection-layer"
HTML = ROOT / "html"
CLIENT = ROOT / "client"

sys.path.insert(0, str(CONNECTION))

from flask import Flask, Response, jsonify, make_response, redirect, request, send_from_directory
from news_mesh import get_news_items  # noqa: E402
from golem_chat import (  # noqa: E402
    backend_status as chat_backend_status,
    chat as golem_chat,
    golem_connection_status,
    list_assistants as chat_list_assistants,
    list_models as chat_list_models,
    stream_chat as golem_stream_chat,
)

import desk_product  # noqa: E402
import chat_history  # noqa: E402

desk_product.apply_chat_env_from_settings()

from chain_state import get_balance, mempool_snapshot  # noqa: E402
from entry_registry import discover, register_hub, snapshot as entry_snapshot  # noqa: E402
from inference_chain import get_chain  # noqa: E402
from mlc import get_balances, get_ledger  # noqa: E402
from net_utils import get_lan_ip  # noqa: E402
from network_hub import get_hub  # noqa: E402
from p2p_sync import ChainSyncer  # noqa: E402
from staking import stake_requirements  # noqa: E402
from treasury import can_claim_faucet, faucet_allowed, faucet_mode, treasury_wallet  # noqa: E402
from rate_limit import check_rate_limit  # noqa: E402
from validators import known_validators, register_peer, set_validator_hub_url, validator_info  # noqa: E402
from federation_auto import bootstrap_federation, federation_peers  # noqa: E402
from gossip_mesh import get_mesh, start_mesh_with_federation  # noqa: E402
from spv import account_proof, verify_account_proof  # noqa: E402
from site_auth import (  # noqa: E402
    SiteAuthError,
    cookie_name as site_cookie_name,
    ensure_bootstrap_admin,
    login as site_login,
    logout as site_logout,
    session_user as site_session_user,
    signup as site_signup,
)

app = Flask(__name__, static_folder=str(HTML / "static"), static_url_path="/static")
_syncer: ChainSyncer | None = None

# Maker account for Chat / Canvas.
# Production: set SITE_USER_ADMIN_PASSWORD (force-updates admin). Local: default admin/admin if missing.
_MAKER_ADMIN_PW = (os.environ.get("SITE_USER_ADMIN_PASSWORD") or "").strip()
if _MAKER_ADMIN_PW:
    ensure_bootstrap_admin("admin", _MAKER_ADMIN_PW, force_password=True)
else:
    ensure_bootstrap_admin("admin", "admin", force_password=False)


def _current_site_user() -> str | None:
    """Resolve maker/desk session from Bearer header or cookies."""
    token = ""
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    if not token:
        token = (request.cookies.get(site_cookie_name(), "") or "").strip()
    if not token:
        token = (request.cookies.get("noeti_maker_token", "") or "").strip()
    return site_session_user(token or None)


def _client_ip() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or ""


@app.route("/")
def index():
    return send_from_directory(HTML, "index.html")


@app.route("/about")
@app.route("/about/")
@app.route("/about.html")
def about_page():
    return send_from_directory(HTML, "about.html")


@app.route("/idea")
@app.route("/idea/")
@app.route("/idea.html")
def idea_page():
    return send_from_directory(HTML, "idea.html")


@app.route("/philosophy")
@app.route("/philosophy/")
@app.route("/philosophy.html")
def philosophy_page():
    return send_from_directory(HTML, "philosophy.html")


@app.route("/facts")
@app.route("/facts/")
@app.route("/facts.html")
def facts_page():
    return send_from_directory(HTML, "facts.html")



@app.route("/proofpath")
@app.route("/proofpath/")
@app.route("/proofpath.html")
def proofpath_page():
    return send_from_directory(HTML, "proofpath.html")


@app.route("/privacy")
@app.route("/privacy/")
@app.route("/privacy.html")
def privacy_page():
    return send_from_directory(HTML, "privacy.html")


@app.route("/witness")
@app.route("/witness/")
@app.route("/witness.html")
def witness_page():
    return send_from_directory(HTML, "witness.html")


@app.route("/contact")
@app.route("/contact/")
@app.route("/contact.html")
def contact_page():
    return send_from_directory(HTML, "contact.html")


@app.route("/chat")
@app.route("/chat/")
@app.route("/chat.html")
def chat_page():
    if not _current_site_user():
        return redirect("/login?next=/chat")
    return send_from_directory(HTML, "chat.html")


@app.route("/editor")
@app.route("/editor/")
@app.route("/editor.html")
def editor_page():
    if not _current_site_user():
        return redirect("/login?next=/editor")
    return send_from_directory(HTML, "editor.html")


@app.route("/canvas")
@app.route("/canvas/")
@app.route("/canvas.html")
def canvas_page():
    if not _current_site_user():
        return redirect("/login?next=/canvas")
    return send_from_directory(HTML, "canvas.html")


@app.route("/proof/<run_id>")
@app.route("/proof/<run_id>/")
def proof_page(run_id: str):
    """Public ProofPath viewer — sealed runs open by link."""
    return send_from_directory(HTML, "proof.html")


@app.route("/proof")
@app.route("/proof/")
def proof_index():
    return send_from_directory(HTML, "proof.html")


@app.route("/phone")
@app.route("/phone/")
def phone_page():
    """Mobile companion — open from Canvas pair link, no app install."""
    return send_from_directory(HTML, "phone.html")


@app.route("/device")
@app.route("/device/")
def device_page():
    """Connect a PC — one command links local Ollama to Canvas."""
    return send_from_directory(HTML, "device.html")


@app.route("/device_agent.py")
def device_agent_py():
    return send_from_directory(ROOT, "device_agent.py", mimetype="text/x-python")


@app.route("/device-agent.sh")
def device_agent_sh():
    return send_from_directory(ROOT, "device-agent.sh", mimetype="text/x-shellscript")


@app.route("/desk")
@app.route("/desk/")
@app.route("/desk.html")
def desk_page():
    return send_from_directory(HTML, "desk.html")


@app.route("/admin")
@app.route("/admin/")
@app.route("/admin.html")
def admin_page():
    return send_from_directory(HTML, "admin.html")


@app.route("/pricing")
@app.route("/pricing/")
@app.route("/pricing.html")
def pricing_page():
    return send_from_directory(HTML, "pricing.html")


@app.route("/pitch")
@app.route("/pitch/")
@app.route("/pitch.html")
def pitch_page():
    return send_from_directory(HTML, "pitch.html")


@app.route("/whitepaper")
@app.route("/whitepaper/")
@app.route("/whitepaper.html")
def whitepaper_page():
    return send_from_directory(HTML, "whitepaper.html")


@app.route("/workflow")
@app.route("/workflow/")
@app.route("/workflow.html")
def workflow_page():
    return redirect("/chat", code=302)


@app.route("/api/chat/status")
def api_chat_status():
    _, err = _require_user()
    if err:
        return err
    return jsonify(chat_backend_status())


@app.route("/api/chat/models")
def api_chat_models():
    _, err = _require_user()
    if err:
        return err
    return jsonify(chat_list_models())


@app.get("/api/golem/status")
def api_golem_status():
    return jsonify(golem_connection_status())


@app.route("/api/chat", methods=["POST"])
def api_chat():
    _, err = _require_user()
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    messages = payload.get("messages") or []
    model = payload.get("model")
    temperature = payload.get("temperature")
    if not isinstance(messages, list):
        return jsonify({"ok": False, "error": "bad_request", "message": "messages must be a list"}), 400
    if model is not None and not isinstance(model, str):
        return jsonify({"ok": False, "error": "bad_request", "message": "model must be a string"}), 400
    if temperature is not None:
        try:
            temperature = float(temperature)
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "bad_request", "message": "temperature must be a number"}), 400
    result = golem_chat(
        messages,
        client_ip=_client_ip(),
        model=model,
        temperature=temperature,
        assistant_id=payload.get("assistant_id"),
        system_prompt=payload.get("system_prompt"),
        web_search=bool(payload.get("web_search")) and not bool(payload.get("prefer_local") or payload.get("private")),
        prefer_local=bool(payload.get("prefer_local") or payload.get("private")),
    )
    code = 200 if result.get("ok") else (429 if result.get("error") == "rate_limited" else 502)
    return jsonify(result), code


@app.post("/api/chat/stream")
def api_chat_stream():
    _, err = _require_user()
    if err:
        return err
    from flask import stream_with_context
    import json as _json

    payload = request.get_json(silent=True) or {}
    messages = payload.get("messages") or []
    if not isinstance(messages, list):
        return jsonify({"ok": False, "message": "messages must be a list"}), 400
    model = payload.get("model")
    temperature = payload.get("temperature")
    if temperature is not None:
        try:
            temperature = float(temperature)
        except (TypeError, ValueError):
            temperature = None

    def generate():
        for ev in golem_stream_chat(
            messages,
            client_ip=_client_ip(),
            model=model if isinstance(model, str) or model is None else None,
            temperature=temperature,
            assistant_id=payload.get("assistant_id"),
            system_prompt=payload.get("system_prompt"),
            web_search=bool(payload.get("web_search")) and not bool(payload.get("prefer_local") or payload.get("private")),
            prefer_local=bool(payload.get("prefer_local") or payload.get("private")),
        ):
            yield f"data: {_json.dumps(ev, ensure_ascii=False)}\n\n"

    resp = Response(stream_with_context(generate()), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


@app.post("/api/canvas/generate")
def api_canvas_generate():
    """Custom AI workflow generator — brief → placeable canvas graph."""
    _, err = _require_user()
    if err:
        return err
    from workflow_generator import generate_workflow

    body = request.get_json(silent=True) or {}
    brief = str(body.get("brief") or body.get("prompt") or body.get("text") or "").strip()
    if not brief:
        return jsonify({"ok": False, "message": "Describe the workflow you want"}), 400
    if len(brief) > 4000:
        brief = brief[:4000]
    use_model = bool(body.get("use_model", True))
    graph = generate_workflow(brief, use_model=use_model)
    return jsonify(graph)


@app.post("/api/canvas/phone/session")
def api_canvas_phone_session():
    """Mint a short-lived phone pair session for Canvas."""
    user, err = _require_user()
    if err:
        return err
    import phone_bridge

    body = request.get_json(silent=True) or {}
    label = str(body.get("label") or "Phone").strip()[:60] or "Phone"
    out = phone_bridge.create_session(owner=str(user or ""), label=label)
    origin = request.host_url.rstrip("/")
    out["pair_url"] = f"{origin}{out['pair_path']}"
    return jsonify(out)


@app.get("/api/canvas/phone/session/<session_id>")
def api_canvas_phone_status(session_id: str):
    """Desktop polls pending phone captures."""
    _, err = _require_user()
    if err:
        return err
    import phone_bridge

    token = request.args.get("token") or None
    out = phone_bridge.session_status(session_id, token)
    code = 200 if out.get("ok") else 404
    if out.get("ok"):
        origin = request.host_url.rstrip("/")
        out["pair_url"] = f"{origin}{out['pair_path']}"
    return jsonify(out), code


@app.post("/api/canvas/phone/touch")
def api_canvas_phone_touch():
    """Phone page heartbeat — no maker login required (token gate)."""
    import phone_bridge

    body = request.get_json(silent=True) or {}
    out = phone_bridge.touch_phone(
        str(body.get("session_id") or ""),
        str(body.get("token") or ""),
        device=str(body.get("device") or ""),
    )
    return jsonify(out), (200 if out.get("ok") else 404)


@app.post("/api/canvas/phone/push")
def api_canvas_phone_push():
    """Phone pushes a photo/note into the Canvas inbox."""
    import phone_bridge

    body = request.get_json(silent=True) or {}
    out = phone_bridge.push_capture(
        str(body.get("session_id") or ""),
        str(body.get("token") or ""),
        image=str(body.get("image") or ""),
        text=str(body.get("text") or ""),
        device=str(body.get("device") or ""),
        kind=str(body.get("kind") or ""),
    )
    code = 200 if out.get("ok") else (400 if out.get("error") in ("empty", "bad_image") else 404)
    return jsonify(out), code


@app.post("/api/canvas/phone/ack")
def api_canvas_phone_ack():
    """Desktop acknowledges consumed inbox items."""
    _, err = _require_user()
    if err:
        return err
    import phone_bridge

    body = request.get_json(silent=True) or {}
    ids = body.get("item_ids") or body.get("ids") or []
    if not isinstance(ids, list):
        ids = []
    out = phone_bridge.ack_items(str(body.get("session_id") or ""), [str(x) for x in ids])
    return jsonify(out), (200 if out.get("ok") else 404)


@app.post("/api/canvas/phone/signal")
def api_canvas_phone_signal():
    """WebRTC signaling — phone (token) or desktop (auth)."""
    import phone_bridge

    body = request.get_json(silent=True) or {}
    role = str(body.get("from_role") or body.get("role") or "").lower()
    sid = str(body.get("session_id") or "")
    token = str(body.get("token") or "") or None
    if role == "desktop":
        _, err = _require_user()
        if err:
            return err
        out = phone_bridge.post_signal(
            sid,
            None,
            from_role="desktop",
            msg_type=str(body.get("type") or ""),
            payload=body.get("payload"),
            require_token=False,
        )
    else:
        out = phone_bridge.post_signal(
            sid,
            token or "",
            from_role="phone",
            msg_type=str(body.get("type") or ""),
            payload=body.get("payload"),
            require_token=True,
        )
    code = 200 if out.get("ok") else (400 if out.get("error") in ("bad_role", "bad_type") else 404)
    return jsonify(out), code


@app.get("/api/canvas/phone/signal/<session_id>")
def api_canvas_phone_signal_pull(session_id: str):
    """Pull pending WebRTC signals for phone or desktop."""
    import phone_bridge

    role = str(request.args.get("role") or "desktop").lower()
    token = request.args.get("token") or None
    if role == "desktop":
        _, err = _require_user()
        if err:
            return err
        out = phone_bridge.pull_signals(session_id, for_role="desktop", require_token=False)
    else:
        out = phone_bridge.pull_signals(
            session_id, for_role="phone", token=token, require_token=True
        )
    return jsonify(out), (200 if out.get("ok") else 404)


@app.post("/api/canvas/phone/command")
def api_canvas_phone_command():
    """Phone remote controls → Canvas (run / seal / freeze / vision)."""
    import phone_bridge

    body = request.get_json(silent=True) or {}
    out = phone_bridge.post_command(
        str(body.get("session_id") or ""),
        str(body.get("token") or ""),
        str(body.get("command") or ""),
        payload=body.get("payload"),
    )
    code = 200 if out.get("ok") else (400 if out.get("error") == "bad_command" else 404)
    return jsonify(out), code


@app.post("/api/canvas/device/session")
def api_canvas_device_session():
    """Mint a PC pair session for Canvas."""
    user, err = _require_user()
    if err:
        return err
    import device_bridge

    body = request.get_json(silent=True) or {}
    label = str(body.get("label") or "My PC").strip()[:60] or "My PC"
    out = device_bridge.create_session(owner=str(user or ""), label=label)
    origin = request.host_url.rstrip("/")
    out["pair_url"] = f"{origin}{out['pair_path']}"
    out["agent_cmd"] = f"curl -sSL {origin}/device-agent.sh | bash -s -- {out['session_id']} {out['token']}"
    return jsonify(out)


@app.get("/api/canvas/device/list")
def api_canvas_device_list():
    user, err = _require_user()
    if err:
        return err
    import device_bridge

    return jsonify(device_bridge.list_devices(owner=str(user or "")))


@app.get("/api/canvas/device/session/<session_id>")
def api_canvas_device_status(session_id: str):
    import device_bridge

    token = request.args.get("token") or None
    # Desktop (authed) or agent page with token
    if not token:
        _, err = _require_user()
        if err:
            return err
    out = device_bridge.session_status(session_id, token)
    if out.get("ok"):
        origin = request.host_url.rstrip("/")
        out["pair_url"] = f"{origin}{out['pair_path']}"
        if token:
            out["agent_cmd"] = (
                f"curl -sSL {origin}/device-agent.sh | bash -s -- {out['session_id']} {token}"
            )
    return jsonify(out), (200 if out.get("ok") else 404)


@app.post("/api/canvas/device/heartbeat")
def api_canvas_device_heartbeat():
    import device_bridge

    body = request.get_json(silent=True) or {}
    models = body.get("models") or []
    if not isinstance(models, list):
        models = []
    out = device_bridge.heartbeat(
        str(body.get("session_id") or ""),
        str(body.get("token") or ""),
        models=[str(m) for m in models],
        ollama=bool(body.get("ollama")),
        hostname=str(body.get("hostname") or ""),
        platform=str(body.get("platform") or ""),
        label=str(body.get("label") or ""),
    )
    return jsonify(out), (200 if out.get("ok") else 404)


@app.get("/api/canvas/device/jobs")
def api_canvas_device_jobs():
    import device_bridge

    sid = str(request.args.get("s") or request.args.get("session_id") or "")
    token = str(request.args.get("t") or request.args.get("token") or "")
    out = device_bridge.claim_job(sid, token)
    return jsonify(out), (200 if out.get("ok") else 404)


@app.post("/api/canvas/device/result")
def api_canvas_device_result():
    import device_bridge

    body = request.get_json(silent=True) or {}
    metrics = body.get("metrics") if isinstance(body.get("metrics"), dict) else {}
    out = device_bridge.submit_result(
        str(body.get("session_id") or ""),
        str(body.get("token") or ""),
        job_id=str(body.get("job_id") or ""),
        reply=str(body.get("reply") or body.get("output") or ""),
        model=str(body.get("model") or ""),
        ok=bool(body.get("ok", True)),
        error=str(body.get("error") or body.get("message") or ""),
        latency_ms=body.get("latency_ms"),
        output=str(body.get("output") or body.get("reply") or ""),
        explain=str(body.get("explain") or ""),
        metrics=metrics,
        kind=str(body.get("kind") or ""),
    )
    return jsonify(out), (200 if out.get("ok") else 404)


@app.post("/api/canvas/device/infer")
def api_canvas_device_infer():
    """Canvas enqueues a job on a paired PC and waits for the result."""
    _, err = _require_user()
    if err:
        return err
    import device_bridge
    import time as _time

    body = request.get_json(silent=True) or {}
    device_id = str(body.get("device_id") or body.get("machine") or "").strip()
    session_id = str(body.get("session_id") or "").strip()
    messages = body.get("messages") or []
    prompt = str(body.get("prompt") or "")
    model = str(body.get("model") or "")
    temperature = float(body.get("temperature") or 0.55)
    timeout = min(180, max(10, int(body.get("timeout") or 90)))

    if session_id:
        enq = device_bridge.enqueue_job(
            session_id,
            messages=messages if isinstance(messages, list) else [],
            prompt=prompt,
            model=model,
            temperature=temperature,
            meta={"source": "canvas"},
        )
    elif device_id:
        enq = device_bridge.enqueue_for_device(
            device_id,
            messages=messages if isinstance(messages, list) else [],
            prompt=prompt,
            model=model,
            temperature=temperature,
            meta={"source": "canvas"},
        )
    else:
        return jsonify({"ok": False, "message": "Pick a connected PC"}), 400

    if not enq.get("ok"):
        return jsonify(enq), 400

    job_id = enq["job_id"]
    # Resolve session for polling
    sid = session_id
    if not sid:
        row = device_bridge.find_session_for_device(device_id)
        sid = (row or {}).get("id") or ""
    deadline = _time.time() + timeout
    while _time.time() < deadline:
        got = device_bridge.get_result(sid, job_id)
        if got.get("ready"):
            if not got.get("ok"):
                return jsonify({"ok": False, "message": got.get("error") or "Device job failed", **got}), 400
            return jsonify(
                {
                    "ok": True,
                    "reply": got.get("reply") or "",
                    "model": got.get("model") or model,
                    "latency_ms": got.get("latency_ms"),
                    "device_id": got.get("device_id") or device_id,
                    "label": got.get("label") or "",
                    "where": f"PC · {got.get('label') or got.get('device_id') or device_id}",
                }
            )
        _time.sleep(0.45)
    return jsonify({"ok": False, "message": "Device timed out — is the agent running?", "job_id": job_id}), 504


@app.get("/api/canvas/local/status")
def api_canvas_local_status():
    """Live local compute + script toolchain status for Canvas."""
    _, err = _require_user()
    if err:
        return err
    import canvas_runtime

    return jsonify({"ok": True, **canvas_runtime.local_status()})


@app.post("/api/canvas/local/setup")
def api_canvas_local_setup():
    """Zero-touch local compute: auto-install Ollama, pull model, ensure site compute."""
    _, err = _require_user()
    if err:
        return err
    import canvas_runtime

    body = request.get_json(silent=True) or {}
    result = canvas_runtime.auto_setup(
        pull=bool(body.get("pull", True)),
        ensure_site=bool(body.get("ensure_site", True)),
        install_ollama=bool(body.get("install_ollama", True)),
    )
    return jsonify(result)


@app.post("/api/canvas/local/install")
def api_canvas_local_install():
    """Force website-driven Ollama download + serve (user does not download manually)."""
    _, err = _require_user()
    if err:
        return err
    import canvas_runtime

    body = request.get_json(silent=True) or {}
    result = canvas_runtime.ensure_ollama_installed(force=bool(body.get("force", False)))
    return jsonify(result)


@app.get("/api/canvas/languages")
def api_canvas_languages():
    _, err = _require_user()
    if err:
        return err
    import canvas_runtime

    langs = canvas_runtime.languages_status()
    return jsonify(
        {
            "ok": True,
            "languages": langs,
            "templates": {row["id"]: row["template"] for row in langs},
            "contract": {
                "stdin_json": {"input": "upstream text", "upstream": "same", "meta": {}},
                "stdout_json": {"ok": True, "output": "text for next block", "explain": "why", "metrics": {}},
            },
        }
    )


@app.post("/api/canvas/script")
def api_canvas_script():
    """Run a snap-in script — defaults to a paired PC (not the server)."""
    user, err = _require_user()
    if err:
        return err
    import canvas_runtime
    import device_bridge
    import time as _time

    body = request.get_json(silent=True) or {}
    lang = (body.get("lang") or body.get("language") or "python").strip()
    source = body.get("source") or body.get("code") or ""
    if not str(source).strip():
        try:
            source = canvas_runtime.default_source(lang)
        except ValueError as exc:
            return jsonify({"ok": False, "message": str(exc)}), 400

    where = str(body.get("where") or "").strip().lower()
    device_id = str(body.get("device_id") or body.get("machine") or "").strip()
    prefer_device = body.get("prefer_device")
    if prefer_device is None:
        # Default: run on the user's PC. Explicit where=server keeps hub runtime.
        prefer_device = where not in ("server", "hub", "cloud")
    force_server = where in ("server", "hub", "cloud") or body.get("force_server")

    timeout = float(body.get("timeout") or canvas_runtime.SCRIPT_TIMEOUT_SEC)
    meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
    upstream = str(body.get("input") or body.get("upstream") or "")

    if prefer_device and not force_server:
        if not device_id:
            first = device_bridge.first_online_device(owner=str(user or ""))
            if first:
                device_id = str(first.get("device_id") or "")
        if not device_id:
            return jsonify({
                "ok": False,
                "message": "Connect your PC first — Editor/Canvas run on your machine, not the server.",
                "explain": "Open Canvas → PC / Device, run the agent command on this computer, then Run again.",
                "need_device": True,
                "where": "pc",
            }), 400

        enq = device_bridge.enqueue_for_device(
            device_id,
            kind="script",
            script={
                "lang": lang,
                "source": str(source),
                "input": upstream,
                "timeout": timeout,
                "meta": meta,
            },
            meta={"surface": meta.get("surface") or "script", "path": meta.get("path") or ""},
        )
        if not enq.get("ok"):
            return jsonify({
                "ok": False,
                "message": enq.get("message") or enq.get("error") or "Device unavailable",
                "need_device": enq.get("error") in ("offline", "not_found"),
                "where": "pc",
            }), 400

        job_id = enq["job_id"]
        session_id = enq.get("session_id") or ""
        if not session_id:
            row = device_bridge.find_session_for_device(device_id)
            session_id = (row or {}).get("id") or ""
        deadline = _time.time() + min(90, max(8, timeout + 15))
        while _time.time() < deadline:
            got = device_bridge.get_result(session_id, job_id)
            if got.get("ready"):
                out = {
                    "ok": bool(got.get("ok")),
                    "output": got.get("output") or got.get("reply") or "",
                    "explain": got.get("explain") or ("Ran on your PC" if got.get("ok") else got.get("error") or ""),
                    "metrics": got.get("metrics") or {},
                    "message": got.get("message") or got.get("error") or "",
                    "where": got.get("where") or f"PC · {enq.get('label') or device_id}",
                    "device_id": device_id,
                    "lang": lang,
                }
                return jsonify(out), (200 if out["ok"] else 400)
            if got.get("error") == "job_not_found":
                break
            _time.sleep(0.35)
        return jsonify({
            "ok": False,
            "message": "PC agent timed out — is device-agent running on that computer?",
            "need_device": True,
            "where": "pc",
            "job_id": job_id,
        }), 504

    # Explicit server / hub fallback
    try:
        result = canvas_runtime.run_script(
            lang=lang,
            source=str(source),
            upstream=upstream,
            meta=meta,
            timeout=timeout,
        )
    except ValueError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 400
    result["where"] = "Server runtime"
    code = 200 if result.get("ok") else 400
    return jsonify(result), code


@app.get("/api/canvas/script/templates")
def api_canvas_script_templates():
    _, err = _require_user()
    if err:
        return err
    import canvas_runtime

    langs = canvas_runtime.languages_status()
    return jsonify(
        {
            "ok": True,
            "languages": [x["id"] for x in langs],
            "templates": {x["id"]: x["template"] for x in langs},
            "python": canvas_runtime.PY_TEMPLATE,
            "c": canvas_runtime.C_TEMPLATE,
            "contract": {
                "stdin": {"input": "upstream text", "upstream": "same", "meta": {}},
                "stdout": {"ok": True, "output": "text for next block", "explain": "why", "metrics": {}},
            },
        }
    )


@app.post("/api/canvas/seal")
def api_canvas_seal():
    """Seal a Canvas board run into a durable ProofPath packet."""
    _, err = _require_user()
    if err:
        return err
    from proofpath_packet import build_packet, save_run

    body = request.get_json(silent=True) or {}
    private = bool(body.get("private") or body.get("prefer_local"))
    judgements = body.get("judgements") or []
    if not judgements and body.get("claims"):
        # Minimal claim rows from canvas output atoms
        for c in (body.get("claims") or [])[:8]:
            text = c if isinstance(c, str) else (c.get("text") or c.get("claim") or "")
            if not text:
                continue
            judgements.append(
                {
                    "claim": text,
                    "judges": body.get("votes") or [],
                    "aggregate": body.get("aggregate")
                    or {"final_verdict": body.get("gate") or "review", "publish_gate": body.get("gate") or "review"},
                }
            )
    workflow = {
        "ok": True,
        "query": (body.get("query") or body.get("title") or "Canvas board run")[:600],
        "worker_model": body.get("worker_model") or "",
        "claims": body.get("claims") or [j.get("claim") for j in judgements if j.get("claim")],
        "sources": body.get("sources") or [],
        "judgements": judgements,
        "summary": {
            "publish_gate": body.get("gate") or "review",
            **(body.get("summary") or {}),
        },
        "activity": body.get("activity") or [],
        "graph": body.get("graph") or {},
        "steps": body.get("steps")
        or [
            {"id": "canvas", "label": "Canvas board execution", "ok": True},
            {"id": "seal", "label": "ProofPath seal", "ok": True},
        ],
        "latency_ms": body.get("latency_ms"),
        "enabled_roles": body.get("roles") or [],
        "note": body.get("note")
        or (
            "Sealed from Noeti Canvas · private local stack."
            if private
            else "Sealed from Noeti Canvas board run."
        ),
    }
    packet = build_packet(workflow, private=private)
    # Attach canvas snapshot for replay
    packet["canvas"] = {
        "nodes": body.get("nodes") or [],
        "edges": body.get("edges") or [],
        "regions": body.get("regions") or [],
        "cam": body.get("cam") or {},
        "fx": body.get("fx"),
        "private": private,
    }
    save_run(packet)
    return jsonify({"ok": True, "run_id": packet["run_id"], "proofpath": packet, "share_path": packet.get("share_path")})


@app.get("/api/chat/assistants")
def api_chat_assistants():
    _, err = _require_user()
    if err:
        return err
    return jsonify(chat_list_assistants())


@app.get("/api/chat/history")
def api_chat_history_get():
    user, err = _require_user()
    if err:
        return err
    return jsonify(chat_history.get_history(user))


@app.post("/api/chat/history")
def api_chat_history_save():
    user, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    return jsonify(chat_history.save_history(user, body.get("chats") or []))


@app.get("/api/workflow/judges")
def api_workflow_judges():
    _, err = _require_user()
    if err:
        return err
    from newsroom_workflow import judge_catalog, WORKER_MODEL

    return jsonify({"ok": True, "worker_model": WORKER_MODEL, "judges": judge_catalog()})


@app.post("/api/workflow/run")
def api_workflow_run():
    _, err = _require_user()
    if err:
        return err
    from newsroom_workflow import run_workflow

    body = request.get_json(silent=True) or {}
    roles = body.get("judges") or body.get("enabled_roles") or None
    if isinstance(roles, str):
        roles = [r.strip() for r in roles.split(",") if r.strip()]
    if roles is not None and not isinstance(roles, list):
        roles = None
    private = bool(body.get("private") or body.get("private_routing"))
    raw_models = body.get("models") or body.get("model_overrides") or {}
    model_overrides = None
    if isinstance(raw_models, dict):
        model_overrides = {
            str(k): str(v).strip()
            for k, v in raw_models.items()
            if str(v).strip() and str(k) in ("checker", "validator", "watcher", "speed_judge", "balance_judge", "skeptic_judge", "editor_judge", "wire_judge")
        } or None
    out = run_workflow(
        body.get("query") or body.get("text") or "",
        enabled_roles=roles,
        private=private,
        model_overrides=model_overrides,
        context=body.get("context") or body.get("reply") or body.get("reply_context") or None,
        explain=bool(body.get("explain") or body.get("reasoning") or body.get("trail")),
    )
    code = 200 if out.get("ok") else 400
    return jsonify(out), code


@app.get("/api/proofpath/runs")
def api_proofpath_list():
    from proofpath_packet import list_runs

    try:
        limit = int(request.args.get("limit") or 20)
    except (TypeError, ValueError):
        limit = 20
    return jsonify({"ok": True, "runs": list_runs(limit)})


@app.get("/api/proofpath/runs/<run_id>")
def api_proofpath_get(run_id):
    from proofpath_packet import get_run

    packet = get_run(run_id)
    if not packet:
        return jsonify({"ok": False, "error": "not_found", "message": "ProofPath run not found"}), 404
    return jsonify({"ok": True, "packet": packet})


@app.get("/api/proofpath/runs/<run_id>/export")
def api_proofpath_export(run_id):
    from proofpath_packet import export_run

    fmt = (request.args.get("format") or "json").lower()
    if fmt not in ("json", "txt"):
        fmt = "json"
    out = export_run(run_id, fmt=fmt)
    if not out.get("ok"):
        return jsonify(out), 404
    if fmt == "txt":
        return Response(
            out.get("content") or "",
            mimetype="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{out.get("filename") or "proofpath.txt"}"'},
        )
    return jsonify(out)


def _admin_ok() -> bool:
    token = request.cookies.get(site_cookie_name(), "") or ""
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip() or token
    user = site_session_user(token.strip() or None)
    if user and str(user).lower() == "admin":
        return True
    key = (os.environ.get("SITE_AUTH_ADMIN_KEY") or "").strip()
    provided = (request.headers.get("X-Admin-Key") or "").strip()
    return bool(key and provided and hmac.compare_digest(provided, key))


def _require_user():
    token = request.cookies.get(site_cookie_name(), "") or ""
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip() or token
    user = site_session_user(token.strip() or None)
    if not user:
        return None, (jsonify({"ok": False, "error": "auth", "message": "Sign in required"}), 401)
    return user, None


@app.get("/api/admin/overview")
def api_admin_overview():
    if not _admin_ok():
        return jsonify({"ok": False, "message": "Admin only"}), 403
    return jsonify(desk_product.admin_overview())


@app.post("/api/admin/settings")
def api_admin_settings():
    if not _admin_ok():
        return jsonify({"ok": False, "message": "Admin only"}), 403
    body = request.get_json(silent=True) or {}
    return jsonify({"ok": True, "settings": desk_product.update_settings(body)})


@app.post("/api/admin/pull-model")
def api_admin_pull_model():
    if not _admin_ok():
        return jsonify({"ok": False, "message": "Admin only"}), 403
    body = request.get_json(silent=True) or {}
    return jsonify(desk_product.pull_ollama_model(body.get("model") or ""))


@app.get("/api/desk/summary")
def api_desk_summary():
    user, err = _require_user()
    if err:
        return err
    return jsonify(desk_product.desk_summary(user))


@app.post("/api/desk/checkout")
def api_desk_checkout():
    user, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    try:
        out = desk_product.create_checkout(
            user,
            body.get("plan") or "solo",
            success_url=body.get("success_url") or "https://noeticompute.com/desk",
            cancel_url=body.get("cancel_url") or "https://noeticompute.com/pricing",
        )
        return jsonify(out)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "message": str(exc)}), 400


@app.post("/api/desk/seats")
def api_desk_seats():
    user, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(desk_product.add_seat(user, body.get("username") or ""))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "message": str(exc)}), 400


@app.post("/api/desk/atomize")
def api_desk_atomize():
    user, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    out = desk_product.atomize_document(user, body.get("title") or "", body.get("body") or "")
    code = 200 if out.get("ok") else (402 if out.get("error") == "quota" else 400)
    return jsonify(out), code


@app.post("/api/desk/from-run")
def api_desk_from_run():
    user, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    run_id = (body.get("run_id") or "").strip()
    from proofpath_packet import get_run

    packet = body.get("packet") or (get_run(run_id) if run_id else None)
    if not packet:
        return jsonify({"ok": False, "error": "not_found", "message": "ProofPath run not found"}), 404
    out = desk_product.import_proofpath_run(user, packet)
    code = 200 if out.get("ok") else (402 if out.get("error") == "quota" else 400)
    return jsonify(out), code


@app.get("/api/desk/projects")
def api_desk_projects():
    user, err = _require_user()
    if err:
        return err
    return jsonify(desk_product.list_projects(user))


@app.get("/api/desk/projects/<project_id>")
def api_desk_project(project_id):
    user, err = _require_user()
    if err:
        return err
    p = desk_product.get_project(user, project_id)
    if not p:
        return jsonify({"ok": False, "message": "Not found"}), 404
    return jsonify({"ok": True, "project": p})


@app.post("/api/desk/projects/<project_id>/witness")
def api_desk_witness(project_id):
    user, err = _require_user()
    if err:
        return err
    out = desk_product.run_witnesses(user, project_id)
    code = 200 if out.get("ok") else (402 if out.get("error") == "quota" else 400)
    return jsonify(out), code


@app.get("/api/desk/projects/<project_id>/export")
def api_desk_export(project_id):
    user, err = _require_user()
    if err:
        return err
    fmt = (request.args.get("format") or "json").lower()
    out = desk_product.export_project(user, project_id, fmt=fmt)
    code = 200 if out.get("ok") else 404
    return jsonify(out), code


@app.route("/static/chat.js")
def chat_js():
    return send_from_directory(HTML / "static", "chat.js", mimetype="application/javascript")


@app.route("/static/admin.js")
def admin_js():
    return send_from_directory(HTML / "static", "admin.js", mimetype="application/javascript")


@app.route("/static/desk.js")
def desk_js():
    return send_from_directory(HTML / "static", "desk.js", mimetype="application/javascript")


@app.route("/static/workflow.js")
def workflow_js():
    return send_from_directory(HTML / "static", "workflow.js", mimetype="application/javascript")


@app.route("/static/site.js")
def site_js():
    return send_from_directory(HTML / "static", "site.js", mimetype="application/javascript")


@app.route("/api/news-mesh")
def api_news_mesh():
    """Live headlines for the homepage investigative mesh background."""
    payload = get_news_items()
    resp = jsonify(payload)
    resp.headers["Cache-Control"] = "public, max-age=60"
    return resp


@app.route("/static/noeti-site.css")
def noeti_site_css():
    return send_from_directory(HTML / "static", "noeti-site.css", mimetype="text/css")


@app.route("/static/home-mesh.js")
def home_mesh_js():
    return send_from_directory(HTML / "static", "home-mesh.js", mimetype="application/javascript")



def _gone_home():
    from flask import redirect
    return redirect("/", code=301)


@app.route("/network")
@app.route("/network/")
@app.route("/network.html")
@app.route("/compute")
@app.route("/compute/")
@app.route("/join")
@app.route("/join.html")
@app.route("/entry")
@app.route("/entry.html")
@app.route("/observer")
@app.route("/observer/")
@app.route("/observer.html")
@app.route("/simulate")
@app.route("/simulate/")
@app.route("/simulate.html")
@app.route("/coin")
@app.route("/coin/")
@app.route("/coin.html")
@app.route("/mlc")
@app.route("/mlc/")
@app.route("/download")
@app.route("/download/")
def scraped_marketing_pages():
    """Old public website pages removed."""
    return _gone_home()


@app.route("/mobile")
def mobile_redirect():
    from flask import redirect
    return redirect("/mobile/", code=301)


@app.route("/mobile/")
def mobile_app():
    html = (CLIENT / "app.html").read_text(encoding="utf-8")
    return Response(html.replace("{{HUB_URL}}", ""), mimetype="text/html")


@app.route("/mobile/manifest.json")
def mobile_manifest():
    return send_from_directory(CLIENT, "manifest.json")


@app.route("/mobile/sw.js")
def mobile_sw():
    return send_from_directory(CLIENT, "sw.js", mimetype="application/javascript")


@app.route("/mobile/static/<path:filename>")
def mobile_static(filename: str):
    return send_from_directory(CLIENT / "static", filename)


@app.route("/join.sh")
def join_script():
    return send_from_directory(ROOT, "join.sh", mimetype="text/x-shellscript")


@app.route("/install.sh")
def install_script():
    return send_from_directory(ROOT, "install.sh", mimetype="text/x-shellscript")


@app.route("/install.ps1")
def install_ps1():
    return send_from_directory(ROOT, "install.ps1", mimetype="text/plain")


@app.route("/downloads/<path:filename>")
def download_file(filename: str):
    return send_from_directory(ROOT / "html" / "downloads", filename, as_attachment=True)


@app.after_request
def security_and_cors(response):
    origin = request.headers.get("Origin", "")
    allowed = (
        origin.startswith("http://127.0.0.1:")
        or origin.startswith("http://localhost:")
        or origin in {"https://noeticompute.com", "https://www.noeticompute.com"}
        or (origin.startswith("https://") and origin.endswith(".noeticompute.com"))
    )
    if allowed and origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


@app.before_request
def cors_preflight():
    # Handle CORS preflight without claiming every unknown /api/* path
    # (a methods=["OPTIONS"] catch-all made missing routes return HTTP 405).
    if request.method == "OPTIONS" and request.path.startswith("/api/"):
        return ("", 204)


def _bootstrap_peers_from_env() -> list[str]:
    raw = os.environ.get("BOOTSTRAP_PEERS", "").strip()
    if not raw:
        return []
    return [part.strip().rstrip("/") for part in raw.split(",") if part.strip()]


def _discovery_payload() -> dict:
    port = request.environ.get("SERVER_PORT", "5052")
    lan = get_lan_ip()
    public = os.environ.get("PUBLIC_URL", request.host_url.rstrip("/"))
    mesh = get_mesh().snapshot()
    chain = get_chain()
    local = validator_info()
    validators = [v.to_dict() for v in known_validators().values()]
    host_ip = os.environ.get("PUBLIC_HOST", "")
    if not host_ip and public.startswith("http"):
        try:
            from urllib.parse import urlparse

            parsed = urlparse(public)
            host_ip = parsed.hostname or ""
        except Exception:
            host_ip = ""
    info = discover(request_url=public, lan_url=f"http://{lan}:{port}")
    hub_snap = get_hub().snapshot()
    bootstrap_peers = _bootstrap_peers_from_env()
    hub_urls = [public.rstrip("/")]
    access_points = [
        {
            "role": "bootstrap",
            "name": "primary",
            "url": public,
            "host_ip": host_ip,
            "lan_ip": lan,
            "api_port": int(port),
            "mesh_port": mesh.get("mesh_port", 5053),
            "validator_pubkey": local.public_key,
            "note": "entry point — validators cosign on the mesh",
        }
    ]
    for index, validator in enumerate(validators, start=1):
        hub_url = str(validator.get("hub_url", "")).rstrip("/")
        if not hub_url or hub_url == public.rstrip("/"):
            continue
        hub_urls.append(hub_url)
        access_points.append(
            {
                "role": "bootstrap",
                "name": f"peer_{index}",
                "url": hub_url,
                "validator_pubkey": validator.get("public_key", ""),
                "address": validator.get("address", ""),
                "note": "federation validator peer",
            }
        )
    for peer_url in bootstrap_peers:
        if peer_url and peer_url not in hub_urls:
            hub_urls.append(peer_url)
            access_points.append(
                {
                    "role": "bootstrap",
                    "name": "BOOTSTRAP_PEERS",
                    "url": peer_url,
                    "note": "BOOTSTRAP_PEERS env",
                }
            )
    for peer in mesh.get("peers") or []:
        access_points.append({"role": "mesh", "peer": peer})

    devices = []
    for node in hub_snap.get("nodes") or []:
        devices.append({**node, "device_type": "compute"})
    for relay in hub_snap.get("relays") or []:
        devices.append({**relay, "device_type": "relay"})

    return {
        **info,
        "public_url": public,
        "host_ip": host_ip,
        "lan_ip": lan,
        "api_port": int(port),
        "mesh_port": mesh.get("mesh_port", 5053),
        "chain_version": chain.snapshot().get("chain_version"),
        "chain_length": len(chain.chain),
        "validator": local.to_dict(),
        "validators": validators,
        "local_app_command": f"python3 launch.py user --hub {public} --open",
        "access_points": access_points,
        "devices": devices,
        "compute_online": hub_snap.get("compute_count", 0),
        "relay_online": hub_snap.get("relay_count", 0),
        "mesh_peers": mesh.get("peers") or [],
        "hub_urls": hub_urls,
        "bootstrap_peers": bootstrap_peers,
        "bootstrap_note": "bootstrap only — verify chain independently",
        "faucet_enabled": faucet_allowed(),
        "faucet_mode": faucet_mode(),
        "task_gossip": mesh.get("task_gossip") or {},
    }


def _entry_text(payload: dict) -> str:
    from datetime import datetime, timezone

    lines = [
        "# Noeti network entry — auto-updated",
        f"# generated: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "# role=bootstrap — website is an entry point, not the network brain",
        "# validators cosign blocks on the mesh; verify chain independently",
        "",
        f"network_name={payload.get('network_name', 'Noeti')}",
        f"role=bootstrap",
        f"public_url={payload.get('public_url', '')}",
        f"host_ip={payload.get('host_ip', '')}",
        f"lan_ip={payload.get('lan_ip', '')}",
        f"api_port={payload.get('api_port', 5052)}",
        f"mesh_port={payload.get('mesh_port', 5053)}",
        f"chain_version={payload.get('chain_version', '')}",
        f"chain_length={payload.get('chain_length', 0)}",
        f"compute_online={payload.get('compute_online', 0)}",
        f"relay_online={payload.get('relay_online', 0)}",
        f"faucet_enabled={payload.get('faucet_enabled', False)}",
        f"faucet_mode={payload.get('faucet_mode', '')}",
        f"validators={len(payload.get('validators') or [])}",
        "",
        "# hub_urls (primary + peer — bootstrap / role=bootstrap)",
    ]
    for hub_url in payload.get("hub_urls") or []:
        lines.append(f"hub_url={hub_url}")
        lines.append(f"bootstrap_url={hub_url}")
    lines.append("")
    lines.append("# bootstrap peers (BOOTSTRAP_PEERS env + federation)")
    bootstrap = payload.get("bootstrap_peers") or []
    if not bootstrap:
        # Federation validator hubs double as bootstrap when env is empty
        fed = [
            str(v.get("hub_url", "")).rstrip("/")
            for v in (payload.get("validators") or [])
            if v.get("hub_url")
        ]
        if fed:
            for peer in fed:
                lines.append(f"bootstrap_peer={peer}")
        else:
            lines.append("bootstrap_peers=none")
    else:
        for peer in bootstrap:
            lines.append(f"bootstrap_peer={peer}")
    lines.extend(
        [
            "",
            "# mesh peers (live gossip)",
        ]
    )
    mesh_peers = payload.get("mesh_peers") or []
    if not mesh_peers:
        lines.append("mesh_peers=none")
    else:
        for peer in mesh_peers:
            lines.append(f"mesh_peer={peer}")
    lines.extend(
        [
            "",
            "# access points (hubs + mesh — connect here)",
        ]
    )
    for index, point in enumerate(payload.get("access_points") or [], start=1):
        lines.append(f"[access_{index}]")
        for key, value in point.items():
            if value not in ("", None):
                lines.append(f"{key}={value}")
        lines.append("")

    lines.append("# devices in network (live)")
    devices = payload.get("devices") or []
    if not devices:
        lines.append("devices=none")
        lines.append("")
    else:
        for device in devices:
            role = device.get("device_type") or device.get("role", "node")
            node_id = device.get("node_id") or device.get("relay_id") or "unknown"
            lines.append(f"[{role}_{node_id}]")
            fields = [
                ("role", role),
                ("node_id", node_id),
                ("status", device.get("status")),
                ("client_ip", device.get("client_ip")),
                ("access_url", device.get("access_url")),
                ("model", device.get("model")),
                ("wallet_address", device.get("wallet_address") or device.get("address")),
                ("enc_pubkey", device.get("enc_pubkey")),
                ("tasks_completed", device.get("tasks_completed")),
                ("tasks_relayed", device.get("tasks_relayed")),
                ("last_action", device.get("last_action")),
            ]
            for key, value in fields:
                if value not in ("", None, 0):
                    lines.append(f"{key}={value}")
            lines.append("")

    lines.extend(["# validators (public keys)"])
    for index, validator in enumerate(payload.get("validators") or [], start=1):
        lines.extend(
            [
                f"[validator_{index}]",
                f"hub_url={validator.get('hub_url', '')}",
                f"validator_id={validator.get('validator_id', '')}",
                f"address={validator.get('address', '')}",
                f"public_key={validator.get('public_key', '')}",
                "",
            ]
        )
    commands = payload.get("join_commands") or {}
    lines.extend(
        [
            "# local app (not hosted on this website)",
            payload.get("local_app_command", ""),
            "",
            "# relay / compute",
            commands.get("relay", ""),
            commands.get("compute", ""),
            "",
            "# clone",
            "git clone https://github.com/streboreziert/Block_chain_Noeti.git",
        ]
    )
    return "\n".join(lines).strip() + "\n"


@app.get("/entry.txt")
@app.get("/network.txt")
def entry_text():
    return Response(_entry_text(_discovery_payload()), mimetype="text/plain; charset=utf-8")


def _hub():
    return get_hub()


@app.get("/api/health")
def health():
    chain = get_chain()
    return jsonify(
        {
            "ok": True,
            "service": "noetis-network",
            "chain_length": len(chain.chain),
            "chain_valid": chain.is_valid_structure() and chain.is_valid_state(),
            "chain_version": chain.snapshot().get("chain_version"),
        }
    )


def _site_token_from_request() -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
        if token:
            return token
    cookie = request.cookies.get(site_cookie_name(), "")
    if cookie.strip():
        return cookie.strip()
    # JS-readable mirror cookie (form login)
    mirror = request.cookies.get("noeti_maker_token", "")
    return mirror.strip() or None


def _site_auth_json_response(payload: dict, *, status: int = 200, token: str | None = None, clear_cookie: bool = False):
    resp = make_response(jsonify(payload), status)
    secure = request.is_secure or request.headers.get("X-Forwarded-Proto", "") == "https"
    if clear_cookie:
        resp.set_cookie(
            site_cookie_name(),
            "",
            max_age=0,
            httponly=True,
            samesite="Lax",
            secure=secure,
            path="/",
        )
    elif token:
        resp.set_cookie(
            site_cookie_name(),
            token,
            max_age=30 * 86400,
            httponly=True,
            samesite="Lax",
            secure=secure,
            path="/",
        )
    return resp


def _site_auth_rate_ok(action: str) -> tuple[bool, str]:
    ip = _client_ip() or "unknown"
    return check_rate_limit(f"site_auth:{action}:{ip}", max_calls=200, window_sec=3600.0)


@app.post("/api/auth/signup")
def api_auth_signup():
    """Public signup for Desk accounts. Optional SITE_AUTH_ADMIN_KEY still accepted but not required."""
    ok, msg = _site_auth_rate_ok("signup")
    if not ok:
        return jsonify({"ok": False, "error": msg}), 429
    body = request.get_json(silent=True) or {}
    try:
        result = site_signup(body.get("username", ""), body.get("password", ""), display=body.get("display"))
    except SiteAuthError as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    return _site_auth_json_response(
        {"ok": True, "username": result["username"], "token": result["token"]},
        token=result["token"],
    )


@app.post("/api/auth/login")
def api_auth_login():
    """Maker / desk login — required for Chat and Canvas."""
    ok, msg = _site_auth_rate_ok("login")
    if not ok:
        return jsonify({"ok": False, "error": msg}), 429
    body = request.get_json(silent=True) or {}
    try:
        result = site_login(body.get("username", ""), body.get("password", ""))
    except SiteAuthError as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    return _site_auth_json_response(
        {"ok": True, "username": result["username"], "token": result["token"]},
        token=result["token"],
    )


def _safe_next_url(raw: str | None, default: str = "/canvas") -> str:
    nxt = (raw or "").strip() or default
    if not nxt.startswith("/") or nxt.startswith("//") or "://" in nxt:
        return default
    return nxt


def _set_maker_cookies(resp, token: str):
    secure = request.is_secure or request.headers.get("X-Forwarded-Proto", "") == "https"
    # HttpOnly session (primary)
    resp.set_cookie(
        site_cookie_name(),
        token,
        max_age=30 * 86400,
        httponly=True,
        samesite="Lax",
        secure=secure,
        path="/",
    )
    # JS-readable mirror so Chat/Canvas fetch can send Bearer if needed
    resp.set_cookie(
        "noeti_maker_token",
        token,
        max_age=30 * 86400,
        httponly=False,
        samesite="Lax",
        secure=secure,
        path="/",
    )
    return resp


@app.route("/login", methods=["GET", "POST"])
@app.route("/login/", methods=["GET", "POST"])
def site_login_form():
    """Top-level form login — sets cookies via real navigation (reliable in browsers)."""
    from urllib.parse import quote

    next_url = _safe_next_url(request.values.get("next"), "/canvas")
    if request.method == "GET":
        if _current_site_user():
            return redirect(next_url)
        return send_from_directory(HTML, "maker_login.html")

    ok, msg = _site_auth_rate_ok("login")
    if not ok:
        return redirect(f"/login?next={quote(next_url)}&auth_error={quote(msg)}")
    try:
        result = site_login(request.form.get("username", ""), request.form.get("password", ""))
    except SiteAuthError as exc:
        return redirect(f"/login?next={quote(next_url)}&auth_error={quote(exc.message)}")
    resp = redirect(next_url)
    return _set_maker_cookies(resp, result["token"])


@app.post("/api/auth/logout")
def api_auth_logout():
    token = _site_token_from_request()
    site_logout(token)
    resp = _site_auth_json_response({"ok": True}, clear_cookie=True)
    secure = request.is_secure or request.headers.get("X-Forwarded-Proto", "") == "https"
    resp.set_cookie("noeti_maker_token", "", max_age=0, httponly=False, samesite="Lax", secure=secure, path="/")
    return resp


@app.get("/api/auth/me")
def api_auth_me():
    username = site_session_user(_site_token_from_request())
    if not username:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    return jsonify({"ok": True, "username": username})


@app.get("/api/onboard")
def onboard():
    address = str(request.args.get("address", "")).strip()
    eligible, message = can_claim_faucet(address) if address else (False, "address required")
    return jsonify(
        {
            "faucet_enabled": faucet_allowed(),
            "faucet_mode": faucet_mode(),
            "min_stake": 10.0,
            "treasury_address": treasury_wallet().address,
            "eligible": eligible if address else None,
            "message": message if address else "Pass ?address= to check faucet eligibility",
            "steps": [
                "Create wallet: python3 wallet_cli.py create (or in local user app)",
                "Request onboarding MLC via faucet",
                "Stake 10 MLC: python3 wallet_cli.py stake --node-id my-gpu",
                "Join compute: python3 launch.py compute --id my-gpu",
            ],
        }
    )


@app.get("/api/validator")
def validator_get():
    info = validator_info()
    return jsonify(
        {
            **info.to_dict(),
            "federation_count": len(known_validators()),
        }
    )


@app.post("/api/validator/register")
def validator_register():
    payload = request.get_json(force=True, silent=True) or {}
    try:
        return jsonify(
            register_peer(
                hub_url=str(payload.get("hub_url", "")).strip(),
                validator_id=str(payload.get("validator_id", "")).strip(),
                public_key=str(payload.get("public_key", "")).strip(),
                address=str(payload.get("address", "")).strip(),
                signature=str(payload.get("signature", "")).strip(),
                timestamp=payload.get("timestamp"),
            )
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/validators")
def validators_list():
    from chain_state import VALIDATOR_MIN_STAKE, on_chain_validators
    from schedule import schedule_snapshot

    chain = get_chain()
    return jsonify(
        {
            "validators": [v.to_dict() for v in known_validators().values()],
            "on_chain": on_chain_validators(chain.current_state()),
            "validator_min_stake": VALIDATOR_MIN_STAKE,
            "proposer_schedule": schedule_snapshot(len(chain.chain)),
        }
    )


@app.get("/api/discovery")
def discovery():
    return jsonify(_discovery_payload())


@app.get("/api/entry")
def entry_info():
    port = request.environ.get("SERVER_PORT", "5052")
    lan = get_lan_ip()
    request_url = request.host_url.rstrip("/")
    return jsonify(entry_snapshot(request_url=request_url, lan_url=f"http://{lan}:{port}"))


@app.get("/api/status")
@app.get("/api/network-status")
def status():
    snap = _hub().snapshot()
    port = request.environ.get("SERVER_PORT", "5052")
    lan = get_lan_ip()
    snap["hub_url"] = request.host_url.rstrip("/")
    snap["lan_url"] = f"http://{lan}:{port}"
    snap["faucet_enabled"] = faucet_allowed()
    snap["faucet_mode"] = faucet_mode()
    snap["app_version"] = app_version()
    snap["join_commands"] = {
        "user": f"python3 launch.py user --hub http://{lan}:{port} --open",
        "relay": f"python3 launch.py relay --hub http://{lan}:{port} --id my-relay",
        "compute": f"python3 launch.py compute --hub http://{lan}:{port} --id my-gpu",
    }
    return jsonify(snap)


@app.get("/api/chain/headers")
def chain_headers():
    return jsonify(get_chain().headers_snapshot())


@app.get("/api/chain/block/<int:index>")
def chain_block(index: int):
    block = get_chain().get_block(index)
    if block is None:
        return jsonify({"error": "Block not found"}), 404
    return jsonify(block)


@app.post("/api/chain/cosign")
def chain_cosign():
    payload = request.get_json(force=True, silent=True) or {}
    block = payload.get("block")
    if not isinstance(block, dict):
        return jsonify({"error": "block required"}), 400
    try:
        return jsonify(_hub().cosign_block(block))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/mesh")
def mesh_status():
    return jsonify(get_mesh().snapshot())


@app.get("/api/chain")
def chain():
    return jsonify(get_chain().snapshot())


@app.get("/api/chain/full")
def chain_full():
    return jsonify(get_chain().full_snapshot())


@app.post("/api/chain/sync")
def chain_sync():
    client_ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()
    ok, reason = check_rate_limit(f"sync:{client_ip}", max_calls=6, window_sec=60.0)
    if not ok:
        return jsonify({"error": reason}), 429
    payload = request.get_json(force=True, silent=True) or {}
    blocks = payload.get("blocks") or []
    if not isinstance(blocks, list):
        return jsonify({"error": "blocks array required"}), 400
    return jsonify(_hub().merge_remote_chain(blocks))


@app.post("/api/chain/finalize-pending")
def chain_finalize_pending():
    from chain_state import drain_mempool

    txs = drain_mempool()
    if not txs:
        return jsonify({"ok": True, "block_index": get_chain().last_block.index, "pending": 0})
    block = get_chain().add_state_block(txs, data="Pending signed transactions")
    return jsonify({"ok": True, "block_index": block.index, "transactions": len(txs)})


@app.post("/api/transfer")
def transfer():
    payload = request.get_json(force=True, silent=True) or {}
    from chain_state import SIGNED_TYPES, validate_transaction

    # System types (credit/slash) are producer-only — never accepted over the API.
    if str(payload.get("type", "")) not in SIGNED_TYPES:
        return jsonify({"error": "Only signed transaction types accepted"}), 400
    state = get_chain().current_state()
    error = validate_transaction(payload, state)
    if error:
        return jsonify({"error": error}), 400
    block = get_chain().add_state_block([payload], data=f"Signed {payload.get('type')}")
    _hub()._log("tx", f"On-chain {payload.get('type')} {payload.get('amount')} MLC")
    return jsonify({"ok": True, "block_index": block.index, "on_chain": True})


@app.get("/api/wallet/proof")
def wallet_proof():
    address = str(request.args.get("address", "")).strip()
    if not address:
        return jsonify({"error": "address required"}), 400
    state = get_chain().current_state()
    proof = account_proof(state, address)
    if proof is None:
        return jsonify({"error": "Account not found"}), 404
    proof["verified"] = verify_account_proof(proof)
    return jsonify(proof)


@app.get("/api/wallet/balance")
def wallet_balance():
    address = str(request.args.get("address", "")).strip()
    if not address:
        return jsonify({"error": "address required"}), 400
    state = get_chain().current_state()
    return jsonify(get_balance(state, address))


@app.get("/api/wallet/nonce")
def wallet_nonce():
    address = str(request.args.get("address", "")).strip()
    if not address:
        return jsonify({"error": "address required"}), 400
    state = get_chain().current_state()
    row = get_balance(state, address)
    return jsonify({"address": address, "nonce": row["nonce"]})


@app.get("/api/staking/status")
def staking_status():
    address = str(request.args.get("address", "")).strip()
    node_id = str(request.args.get("node_id", "")).strip()
    if not address or not node_id:
        return jsonify({"error": "address and node_id required"}), 400
    state = get_chain().current_state()
    return jsonify(stake_requirements(state, address, node_id))


@app.post("/api/faucet")
def faucet():
    client_ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()
    ok, reason = check_rate_limit(f"faucet:{client_ip}", max_calls=30, window_sec=86400.0)
    if not ok:
        return jsonify({"error": reason}), 429
    payload = request.get_json(force=True, silent=True) or {}
    address = str(payload.get("address", "")).strip()
    amount = float(payload.get("amount", 0) or 0)
    if not address:
        return jsonify({"error": "address required"}), 400
    try:
        return jsonify(_hub().grant_faucet(address, amount or 50))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/mempool")
def mempool():
    return jsonify({"transactions": mempool_snapshot()})


@app.get("/api/transactions")
def transactions():
    from datetime import datetime

    entries = get_ledger(limit=50)
    for entry in entries:
        entry["time_str"] = datetime.fromtimestamp(entry["time"]).strftime("%H:%M:%S")
    return jsonify({"transactions": entries, "token": "MLC"})


@app.get("/api/architecture")
def architecture():
    return jsonify(_hub().snapshot()["architecture"])


@app.post("/api/relay/register")
def relay_register():
    payload = request.get_json(force=True, silent=True) or {}
    relay_id = str(payload.get("relay_id", "")).strip()
    if not relay_id:
        return jsonify({"error": "relay_id required"}), 400
    try:
        return jsonify(
            _hub().register_relay(
                relay_id,
                client_ip=_client_ip(),
                access_url=str(payload.get("access_url", "")).strip(),
            )
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/relay/heartbeat")
def relay_heartbeat():
    payload = request.get_json(force=True, silent=True) or {}
    relay_id = str(payload.get("relay_id", "")).strip()
    if not relay_id:
        return jsonify({"error": "relay_id required"}), 400
    try:
        return jsonify(_hub().relay_heartbeat(relay_id))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/relay/poll")
def relay_poll():
    relay_id = str(request.args.get("relay_id", "")).strip()
    if not relay_id:
        return jsonify({"error": "relay_id required"}), 400
    try:
        task = _hub().poll_relay_task(relay_id)
        return jsonify(task or {})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/relay/forward")
def relay_forward():
    payload = request.get_json(force=True, silent=True) or {}
    relay_id = str(payload.get("relay_id", "")).strip()
    task_id = str(payload.get("task_id", "")).strip()
    if not relay_id or not task_id:
        return jsonify({"error": "relay_id and task_id required"}), 400
    try:
        return jsonify(_hub().forward_relay_task(relay_id, task_id))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/compute/register")
def compute_register():
    payload = request.get_json(force=True, silent=True) or {}
    node_id = str(payload.get("node_id", "")).strip()
    model = str(payload.get("model", "qwen2.5:0.5b"))
    wallet_address = str(payload.get("wallet_address", "")).strip()
    enc_pubkey = str(payload.get("enc_pubkey", "")).strip()
    runtime = str(payload.get("runtime", "ollama")).strip() or "ollama"
    coordinator = bool(payload.get("coordinator"))
    if not node_id:
        return jsonify({"error": "node_id required"}), 400
    try:
        result = _hub().register_compute(
            node_id,
            model,
            wallet_address,
            enc_pubkey,
            client_ip=_client_ip(),
            access_url=str(payload.get("access_url", "")).strip(),
            runtime=runtime,
            coordinator=coordinator,
        )
        result["hub_url"] = request.host_url.rstrip("/")
        return jsonify(result)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/compute/heartbeat")
def compute_heartbeat():
    payload = request.get_json(force=True, silent=True) or {}
    node_id = str(payload.get("node_id", "")).strip()
    if not node_id:
        return jsonify({"error": "node_id required"}), 400
    try:
        return jsonify(_hub().heartbeat(node_id))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/compute/unregister")
@app.post("/api/compute/leave")
def compute_unregister():
    """Stop Earn / leave mesh — drop node from live registry immediately."""
    payload = request.get_json(force=True, silent=True) or {}
    node_id = str(payload.get("node_id", "")).strip()
    if not node_id:
        return jsonify({"error": "node_id required"}), 400
    try:
        return jsonify(_hub().unregister_compute(node_id))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/compute/poll")
def compute_poll():
    node_id = str(request.args.get("node_id", "")).strip()
    if not node_id:
        return jsonify({"error": "node_id required"}), 400
    try:
        task = _hub().poll_task(node_id)
        return jsonify(task or {})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/compute/offers")
def compute_offers():
    """List open TASK_OFFERs for mesh-first claim (poll remains fallback)."""
    node_id = str(request.args.get("node_id", "")).strip()
    if not node_id:
        return jsonify({"error": "node_id required"}), 400
    try:
        offers = _hub().list_open_offers(node_id)
        return jsonify({"offers": offers, "count": len(offers)})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/compute/claim")
def compute_claim():
    """Claim a specific open offer by task_id (mesh-first path)."""
    payload = request.get_json(force=True, silent=True) or {}
    node_id = str(payload.get("node_id", "")).strip()
    task_id = str(payload.get("task_id", "")).strip()
    if not node_id or not task_id:
        return jsonify({"error": "node_id and task_id required"}), 400
    try:
        task = _hub().claim_task(node_id, task_id)
        return jsonify(task)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/compute/result")
def compute_result():
    payload = request.get_json(force=True, silent=True) or {}
    try:
        return jsonify(
            _hub().submit_result(
                task_id=str(payload.get("task_id", "")),
                node_id=str(payload.get("node_id", "")),
                response=str(payload.get("response", "")),
                inference_ms=float(payload.get("inference_ms", 0)),
                model=str(payload.get("model", "")),
                attestation=payload.get("attestation"),
                response_encrypted=bool(payload.get("response_encrypted")),
                response_ciphertext=str(payload.get("response_ciphertext", "")),
                response_nonce=str(payload.get("response_nonce", "")),
            )
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


def _pack_app_version() -> str | None:
    """Prefer version stamped by pack-downloads.sh into html/downloads/VERSION.

    Never bump NOETIS_APP_VERSION (env/compose) without re-running pack-downloads.sh —
    /api/version prefers the pack file so advertised updates match downloadable zips.
    """
    candidates = (
        Path(__file__).resolve().parent / "html" / "downloads" / "VERSION",
        Path("html/downloads/VERSION"),
    )
    for p in candidates:
        try:
            if p.is_file():
                ver = p.read_text(encoding="utf-8").strip().splitlines()[0].strip()
                if ver:
                    return ver
        except OSError:
            continue
    return None


def app_version() -> str:
    return _pack_app_version() or os.environ.get("NOETIS_APP_VERSION", "0.5.35")



@app.get("/api/version")
def api_version():
    """App update channel — desktop/phone Check for updates.

    Prefer html/downloads/VERSION (written by pack-downloads.sh) over env so the
    hub never advertises a version that is not in the downloadable packs.
    Never bump NOETIS_APP_VERSION without packing.
    """
    ver = app_version()
    base = os.environ.get("PUBLIC_URL", request.host_url.rstrip("/")).rstrip("/")
    return jsonify(
        {
            "version": ver,
            "chain_version": 4,
            "downloads": {
                "macos_aarch64": f"{base}/downloads/noetis-macos-aarch64.zip",
                "macos_x86_64": f"{base}/downloads/noetis-macos-x86_64.zip",
                "windows_x86_64": f"{base}/downloads/noetis-windows-x86_64.zip",
                "linux_x86_64": f"{base}/downloads/noetis-linux-x86_64.zip",
                "linux_aarch64": f"{base}/downloads/noetis-linux-aarch64.zip",
                "phone": f"{base}/mobile/",
            },
        }
    )


@app.post("/api/infer")
@app.post("/api/prompt")
def infer():
    client_ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()
    ok, reason = check_rate_limit(f"infer:{client_ip}", max_calls=12, window_sec=60.0)
    if not ok:
        return jsonify({"error": reason}), 429

    payload = request.get_json(force=True, silent=True) or {}
    prompt = str(payload.get("text") or payload.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "text required"}), 400

    mode = str(payload.get("mode") or "fast").strip().lower()
    if mode not in {"fast", "verified"}:
        mode = "fast"
    internet = bool(payload.get("internet"))
    max_tokens = payload.get("max_tokens")
    if max_tokens is None:
        max_tokens = payload.get("num_predict")

    hub = _hub()
    try:
        task_id = hub.start_infer(
            prompt,
            mode=mode,
            internet=internet,
            max_tokens=max_tokens,
        )
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 429 if "Too many" in str(exc) else 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    def _run() -> None:
        try:
            hub.dispatch_infer(task_id)
        except Exception as exc:
            hub.last_error = str(exc)

    threading.Thread(target=_run, daemon=True, name=f"network-infer-{task_id}").start()
    return jsonify(
        {
            "ok": True,
            "started": True,
            "task_id": task_id,
            "mode": mode,
            "internet": internet,
        }
    )


@app.get("/api/task/<task_id>")
def api_task(task_id: str):
    """Poll a specific inference by id (no shared last_task race)."""
    hub = _hub()
    data = hub.get_task(task_id)
    if not data:
        return jsonify({"error": "task not found", "task_id": task_id}), 404
    return jsonify(data)


@app.get("/api/wallets")
def wallets():
    rows = get_balances()
    return jsonify({"token": "MLC", "wallets": rows, "count": len(rows)})


def _bootstrap_once() -> None:
    if getattr(_bootstrap_once, "_done", False):
        return
    hub = get_hub()
    hub.role = os.environ.get("HUB_ROLE", "entry")
    hub.model = os.environ.get("HUB_MODEL", "qwen2.5:1.5b")
    hub.bootstrap()
    try:
        site = hub.ensure_site_compute()
        if site.get("ok"):
            print(f"[hub] site compute online: {site.get('node_id')} · {site.get('model')}", flush=True)
        else:
            print(f"[hub] site compute skipped: {site.get('error', 'unavailable')}", flush=True)
    except Exception as exc:
        print(f"[hub] site compute bootstrap error: {exc}", flush=True)
    public = os.environ.get("PUBLIC_URL", "").rstrip("/")
    if public:
        lan = get_lan_ip()
        port = os.environ.get("PORT", "5052")
        register_hub(public, name="entry-hub", lan_url=f"http://{lan}:{port}")
        set_validator_hub_url(public)
        bootstrap_federation(public)
        peer_urls = list(
            {v.hub_url for v in known_validators().values() if v.hub_url}
            | set(federation_peers())
            | set(_bootstrap_peers_from_env())
        )
        start_mesh_with_federation(peer_urls)
    _bootstrap_once._done = True  # type: ignore[attr-defined]


_bootstrap_once()


def main() -> None:
    parser = argparse.ArgumentParser(description="Noetis network hub")
    parser.add_argument("--role", default="hub", choices=["hub", "entry"], help="Server role")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5052)
    parser.add_argument("--public-url", default="", help="Public entry URL (e.g. https://noeticompute.com)")
    parser.add_argument("--sync-peers", action="store_true", help="Enable background P2P chain sync")
    parser.add_argument("--model", default="qwen2.5:0.5b")
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()

    hub = get_hub()
    hub.model = args.model
    hub.role = args.role
    boot = hub.bootstrap()

    lan = get_lan_ip()
    display_host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    url = f"http://{display_host}:{args.port}/"
    hub_url = f"http://{display_host}:{args.port}"
    lan_hub = f"http://{lan}:{args.port}"
    public = args.public_url.rstrip("/") or lan_hub
    register_hub(public, name="entry-hub", lan_url=lan_hub)
    if public:
        set_validator_hub_url(public)

    global _syncer
    if args.sync_peers and args.public_url:
        _syncer = ChainSyncer(args.public_url)
        _syncer.start_background(30.0)

    entry_url = hub_url
    print("")
    print("  Noeti Network — Entry Point + Hub")
    print(f"  Discovery:   {entry_url}")
    print(f"  Local app:   python3 launch.py user --hub {public} --open")
    print(f"  Hub URL:     {hub_url}")
    if lan != "127.0.0.1":
        print(f"  Share (LAN): {lan_hub}")
    if args.public_url:
        print(f"  Public URL:  {public}")
    print("")
    print("  Network entry — others connect here:")
    print(f"    {public}/")
    print("")
    print("  Join commands:")
    print(f"    python3 launch.py user    --hub {public} --open")
    print(f"    python3 launch.py relay   --hub {public} --id my-relay")
    print(f"    python3 launch.py compute --hub {public} --id my-gpu")
    print("")
    if boot.get("ok"):
        print(f"  Compute online: {boot.get('compute_nodes', 0)}")
        if boot.get("local_fallback"):
            print(f"  Local fallback: {boot.get('model')}")
    else:
        print(f"  Warning: {boot.get('error')}")
    print("")

    if args.open:
        webbrowser.open(hub_url)

    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
