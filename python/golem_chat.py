"""Noeti chat: independent node models + full network catalog routing."""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from threading import Lock
from typing import Any

_SYSTEM = (
    "You are Noeti Chat — a normal, friendly assistant. "
    "Answer everyday questions in plain language (cooking, how-tos, explanations, ideas). "
    "Give useful steps and tips; do NOT turn ordinary requests into code or scripts unless the user "
    "explicitly asks for code, a program, or a file. "
    "Help with claim checks and ProofPath when asked. Never refuse ordinary harmless requests. "
    "Do not invent citations. If unsure, say so briefly."
)

ASSISTANTS: list[dict] = [
    {
        "id": "default",
        "name": "Noeti default",
        "desc": "Normal helpful chat",
        "system": _SYSTEM,
    },
    {
        "id": "skeptic",
        "name": "Skeptic editor",
        "desc": "Hostile to weak claims",
        "system": (
            "You are a skeptical desk editor. Challenge weak sourcing, mark speculation, "
            "and prefer contested over supported when evidence is thin. Be concise. "
            "Do not answer with code unless the user asks for code."
        ),
    },
    {
        "id": "wire",
        "name": "Wire reporter",
        "desc": "Neutral wire-style briefs",
        "system": (
            "You write like a wire-service reporter: neutral, short ledes, named sources when known, "
            "no fluff. Prefer facts over opinion. Do not answer with code unless asked."
        ),
    },
    {
        "id": "coder",
        "name": "Code workbench",
        "desc": "Only when you want code-first answers",
        "system": (
            "You are a senior engineer, but only when the user asks for code, debugging, or files. "
            "If they ask an everyday non-coding question (recipes, explanations, advice), answer in "
            "plain language with no scripts. When they do want code, prefer working fenced blocks "
            "with language tags; for files use a first-line comment like # main.py or // app.ts."
        ),
    },
    {
        "id": "coding_helper",
        "name": "Coding helper",
        "desc": "Map-first coding with Second Brain allowlist",
        "system": (
            "You are Noeti Coding Helper. When a WORKSPACE MAP is present, treat it as the source of truth — "
            "do not invent directory searches for paths already listed. Stay inside the allowlist. "
            "If you need another file, ask the user to allow it in Second Brain. "
            "Prefer minimal diffs and fenced code with a first-line path comment. "
            "For non-coding questions, answer briefly in plain language."
        ),
    },
    {
        "id": "teacher",
        "name": "Plain teacher",
        "desc": "Explain simply, step by step",
        "system": (
            "You teach clearly. Use short paragraphs, examples, and check understanding. "
            "Avoid jargon unless you define it. Do not answer with code unless asked."
        ),
    },
]

_ASSISTANTS_BY_ID = {a["id"]: a for a in ASSISTANTS}

# Local / independent-node catalog (Ollama ids). Always shown.
NODE_CATALOG: list[dict] = [
    {"id": "qwen2.5:0.5b", "name": "Qwen 2.5 0.5B", "family": "Qwen", "tier": "fast", "desc": "On-node default", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "qwen2.5:1.5b", "name": "Qwen 2.5 1.5B", "family": "Qwen", "tier": "fast", "desc": "On-node small upgrade", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "llama3.2:1b", "name": "Llama 3.2 1B", "family": "Meta", "tier": "fast", "desc": "On-node · self-hostable", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "gemma2:2b", "name": "Gemma 2 2B", "family": "Google", "tier": "fast", "desc": "On-node · self-hostable", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "tinyllama", "name": "TinyLlama 1.1B", "family": "TinyLlama", "tier": "fast", "desc": "On-node · self-hostable", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "qwen2.5:3b", "name": "Qwen 2.5 3B", "family": "Qwen", "tier": "balanced", "desc": "Decentralized · can self-host", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "qwen2.5:7b", "name": "Qwen 2.5 7B", "family": "Qwen", "tier": "strong", "desc": "Decentralized · can self-host", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "llama3.2:3b", "name": "Llama 3.2 3B", "family": "Meta", "tier": "balanced", "desc": "Decentralized · can self-host", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "llama3.1:8b", "name": "Llama 3.1 8B", "family": "Meta", "tier": "strong", "desc": "Decentralized · can self-host", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "mistral:7b", "name": "Mistral 7B", "family": "Mistral", "tier": "strong", "desc": "Decentralized · can self-host", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "gemma2:9b", "name": "Gemma 2 9B", "family": "Google", "tier": "strong", "desc": "Decentralized · can self-host", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "phi3:mini", "name": "Phi-3 Mini", "family": "Microsoft", "tier": "balanced", "desc": "Decentralized · can self-host", "paid": False, "enabled": True, "deployment": "decentralized"},
    {"id": "deepseek-r1:7b", "name": "DeepSeek R1 7B", "family": "DeepSeek", "tier": "strong", "desc": "Decentralized · can self-host", "paid": False, "enabled": True, "deployment": "decentralized"},
]

# Closed / hosted APIs — cannot run as your own independent node.
_CENTRALIZED_PROVIDERS = {
    "openai",
    "anthropic",
    "x-ai",
    "xai",
    "cohere",
    "perplexity",
    "amazon",
    "ai21",
    "inflection",
    "character",
    "writer",
}

# Open-weight / self-hostable families (even when reached via network mesh).
_INDEPENDENT_PROVIDERS = {
    "meta-llama",
    "qwen",
    "deepseek",
    "mistralai",
    "nousresearch",
    "huggingface",
    "microsoft",  # Phi open weights
    "google",  # gemma only — gemini handled below
    "liquid",
    "01-ai",
    "yi",
    "nvidia",
    "openchat",
    "gryphe",
    "undi95",
    "cognitivecomputations",
    "sao10k",
    "togethercomputer",
    "thudm",
    "inclusionai",
    "moonshotai",
    "minimax",
    "z-ai",
    "aion-labs",
    "allenai",
    "eleutherai",
    "tiktok",
}

_rate_lock = Lock()
_rate: dict[str, list[float]] = {}
_installed_cache: dict = {"ts": 0.0, "names": set()}
_network_cache: dict = {"ts": 0.0, "models": []}


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _http_json(
    url: str,
    payload: dict | None = None,
    headers: dict | None = None,
    timeout: int = 90,
    method: str | None = None,
) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            **(headers or {}),
        },
        method=method or ("POST" if data is not None else "GET"),
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw) if raw else {}


def _network_key() -> str:
    return _env("OPENROUTER_API_KEY") or _env("OPEN_ROUTER_API_KEY") or _env("NETWORK_CHAT_API_KEY")


def _network_configured() -> bool:
    return bool(_network_key())


def _network_base() -> str:
    return (
        _env("NETWORK_CHAT_BASE_URL")
        or _env("OPENROUTER_BASE_URL")
        or "https://openrouter.ai/api/v1"
    ).rstrip("/")


def _installed_ollama() -> set[str]:
    now = time.time()
    if _installed_cache["names"] and now - _installed_cache["ts"] < 30:
        return set(_installed_cache["names"])
    host = _env("OLLAMA_HOST", "http://ollama:11434").rstrip("/")
    names: set[str] = set()
    try:
        data = _http_json(f"{host}/api/tags", timeout=8)
        for m in data.get("models") or []:
            name = (m.get("name") or "").strip()
            if name:
                names.add(name)
                # Also accept untagged aliases only when the model has no tag / default tag
                if ":" not in name or name.endswith(":latest"):
                    names.add(name.split(":")[0])
    except Exception:  # noqa: BLE001
        pass
    _installed_cache["ts"] = now
    _installed_cache["names"] = names
    return names


def _is_free_pricing(pricing: dict | None) -> bool:
    p = pricing or {}
    try:
        return float(p.get("prompt") or 0) == 0 and float(p.get("completion") or 0) == 0
    except (TypeError, ValueError):
        return False


def _classify_deployment(model_id: str, name: str = "", *, hugging_face_id: str | None = None) -> str:
    """decentralized = could run on own hardware; centralized = closed hosted API."""
    mid = (model_id or "").lower()
    nm = (name or "").lower()
    provider = mid.split("/")[0].lstrip("~") if "/" in mid else ""

    if provider in _CENTRALIZED_PROVIDERS:
        return "centralized"
    if "gemini" in mid or "gemini" in nm:
        return "centralized"
    if provider == "google" and "gemma" not in mid and "gemma" not in nm:
        return "centralized"
    if hugging_face_id or provider in _INDEPENDENT_PROVIDERS:
        return "decentralized"
    if any(tok in mid for tok in ("llama", "qwen", "mistral", "mixtral", "gemma", "phi-", "deepseek", "yi-", "wizard")):
        return "decentralized"
    # Unknown network models default to centralized/paid posture
    return "centralized"


def _tier_from_context(ctx: int | None, name: str) -> str:
    n = (name or "").lower()
    if any(x in n for x in ("mini", "flash", "small", "nano", "tiny", "haiku")):
        return "fast"
    if any(x in n for x in ("opus", "ultra", "pro", "large", "70b", "405b", "r1")):
        return "flagship"
    if ctx and ctx >= 200000:
        return "flagship"
    if any(x in n for x in ("sonnet", "medium", "32b", "27b", "14b")):
        return "strong"
    return "balanced"


def _family_from_id(model_id: str, name: str) -> str:
    provider = model_id.split("/")[0].lstrip("~") if "/" in model_id else "Network"
    mapping = {
        "openai": "OpenAI",
        "anthropic": "Anthropic",
        "google": "Google",
        "meta-llama": "Meta",
        "qwen": "Qwen",
        "mistralai": "Mistral",
        "deepseek": "DeepSeek",
        "x-ai": "xAI",
        "cohere": "Cohere",
        "perplexity": "Perplexity",
        "amazon": "Amazon",
        "microsoft": "Microsoft",
        "nvidia": "NVIDIA",
        "moonshotai": "Moonshot",
        "minimax": "MiniMax",
        "z-ai": "Z.AI",
        "openrouter": "Network",
    }
    return mapping.get(provider, provider.replace("-", " ").title() or name.split()[0] if name else "Network")


def _fetch_network_models() -> list[dict]:
    """Pull full remote catalog; cache ~10 minutes. Never expose vendor name in labels."""
    now = time.time()
    if _network_cache["models"] and now - _network_cache["ts"] < 600:
        return list(_network_cache["models"])
    if not _network_configured():
        _network_cache["models"] = []
        _network_cache["ts"] = now
        return []

    url = f"{_network_base()}/models"
    headers = {
        "Authorization": f"Bearer {_network_key()}",
        "HTTP-Referer": _env("OPENROUTER_SITE_URL") or _env("PUBLIC_URL") or "https://noeticompute.com",
        "X-Title": _env("OPENROUTER_APP_NAME") or "Noeti Chat",
    }
    try:
        data = _http_json(url, headers=headers, timeout=25)
    except Exception:  # noqa: BLE001
        return list(_network_cache["models"] or [])

    out: list[dict] = []
    for raw in data.get("data") or []:
        mid = (raw.get("id") or "").strip()
        if not mid:
            continue
        # Skip vendor meta-routers / branded wrappers
        if mid.startswith("openrouter/") or mid.startswith("~openrouter/"):
            continue
        name = (raw.get("name") or mid).strip()
        # Strip any vendor branding from display names
        for bad in ("(OpenRouter)", "OpenRouter", "via OpenRouter", "openrouter"):
            name = name.replace(bad, "").replace(bad.lower(), "").strip(" -·|")
        pricing = raw.get("pricing") or {}
        free = _is_free_pricing(pricing)
        deployment = _classify_deployment(
            mid,
            name,
            hugging_face_id=raw.get("hugging_face_id"),
        )
        paid = deployment == "centralized" or not free
        ctx = raw.get("context_length")
        try:
            ctx_i = int(ctx) if ctx is not None else None
        except (TypeError, ValueError):
            ctx_i = None
        desc = "Centralized · paid" if deployment == "centralized" else "Decentralized · can self-host"
        if free and deployment == "independent":
            desc = "Decentralized · free route"
        elif not free and deployment == "independent":
            desc = "Decentralized · can self-host"
        out.append(
            {
                "id": mid,
                "name": name,
                "family": _family_from_id(mid, name),
                "tier": _tier_from_context(ctx_i, name),
                "desc": desc,
                "paid": paid,
                "enabled": True,
                "deployment": deployment,
                "provider": "network",
                "network_id": mid,
                "free_route": free,
                "context_length": ctx_i,
            }
        )

    out.sort(key=lambda m: (0 if m["deployment"] == "decentralized" else 1, m["family"], m["name"]))
    _network_cache["ts"] = now
    _network_cache["models"] = out
    return list(out)


def _default_model_id() -> str:
    pref = _env("OPENROUTER_DEFAULT_MODEL") or _env("NETWORK_DEFAULT_MODEL") or "openai/gpt-4o-mini"
    # Allow short alias
    if pref == "gpt-4o-mini":
        pref = "openai/gpt-4o-mini"
    if _network_configured():
        return pref
    return _env("HUB_MODEL", "qwen2.5:0.5b")


def backend_status() -> dict:
    ollama = _env("OLLAMA_HOST", "http://ollama:11434")
    installed = sorted(_installed_ollama())
    remote = _env("GOLEM_CHAT_BASE_URL") or _env("REMOTE_CHAT_BASE_URL")

    if _network_configured():
        return {
            "ok": True,
            "backend": "network",
            "label": "Noeti network catalog",
            "detail": "Full model mesh · decentralized + centralized. Local node models still available.",
            "model": _default_model_id(),
            "ready": True,
            "installed": installed,
            "network": True,
        }

    default = (
        _env("GOLEM_CHAT_MODEL")
        or _env("REMOTE_CHAT_MODEL")
        or _env("HUB_MODEL", "qwen2.5:0.5b")
    )
    if remote:
        return {
            "ok": True,
            "backend": "remote",
            "label": "Noeti network",
            "detail": "OpenAI-compatible remote inference endpoint",
            "model": default,
            "ready": True,
            "installed": installed,
            "network": False,
        }
    return {
        "ok": True,
        "backend": "noeti-node",
        "label": "Noeti decentralized node",
        "detail": "Local Ollama. Add a network catalog API key in Admin for the full model list.",
        "model": default,
        "ollama_host": ollama,
        "ready": True,
        "installed": installed,
        "network": False,
    }


def golem_connection_status() -> dict:
    status = backend_status()
    base = _env("GOLEM_CHAT_BASE_URL") or _env("REMOTE_CHAT_BASE_URL")
    net_on = _network_configured()
    return {
        "ok": True,
        "connected": status["backend"] in ("remote", "network"),
        "backend": status["backend"],
        "label": status["label"],
        "network": net_on,
        "network_key_set": net_on,
        "network_base_url_set": bool(base),
        "network_base_url": base[:48] + ("…" if len(base) > 48 else "") if base else "",
        "golem_base_url_set": bool(base),
        "golem_base_url": base[:48] + ("…" if len(base) > 48 else "") if base else "",
        "model": status.get("model"),
        "website": "https://noeticompute.com/chat",
        "how_to_connect": (
            "Network catalog connected."
            if net_on
            else "Paste network catalog API key in Admin to unlock the full model list."
        ),
    }


def list_models() -> dict:
    status = backend_status()
    installed = set(status.get("installed") or [])
    default = status["model"]
    net_on = _network_configured()
    models: list[dict] = []
    seen: set[str] = set()

    # 1) Local node models first
    for m in NODE_CATALOG:
        mid = m["id"]
        on_node = mid in installed
        models.append(
            {
                **m,
                "available": True,
                "on_node": on_node,
                "locked": False,
                "default": mid == default,
                "deployment": "decentralized",
                "deployment_label": "Decentralized",
                "card": {
                    "context_length": None,
                    "deployment": "decentralized",
                    "can_self_host": True,
                    "paid": False,
                    "free_route": True,
                    "provider_family": m.get("family"),
                    "tier": m.get("tier"),
                    "on_node": on_node,
                },
            }
        )
        seen.add(mid)

    # 2) Full network catalog (~300–400)
    if net_on:
        for m in _fetch_network_models():
            mid = m["id"]
            if mid in seen:
                continue
            seen.add(mid)
            dep = m.get("deployment") or "centralized"
            models.append(
                {
                    **m,
                    "available": True,
                    "on_node": False,
                    "locked": False,
                    "default": mid == default,
                    "deployment_label": "Decentralized" if dep == "decentralized" else "Centralized · paid",
                    "card": {
                        "context_length": m.get("context_length"),
                        "deployment": dep,
                        "can_self_host": dep == "decentralized",
                        "paid": bool(m.get("paid")),
                        "free_route": bool(m.get("free_route")),
                        "provider_family": m.get("family"),
                        "tier": m.get("tier"),
                    },
                }
            )

    return {
        "ok": True,
        "backend": status["backend"],
        "label": status["label"],
        "default": default,
        "models": models,
        "count": len(models),
        "paid_count": sum(1 for m in models if m.get("paid")),
        "free_count": sum(1 for m in models if not m.get("paid")),
        "decentralized_count": sum(1 for m in models if m.get("deployment") == "decentralized"),
        "centralized_count": sum(1 for m in models if m.get("deployment") == "centralized"),
        "network": net_on,
    }


def _resolve_model(requested: str | None, *, prefer_local: bool = False) -> tuple[str, dict]:
    status = backend_status()
    default = status["model"]
    req = (requested or default or "qwen2.5:0.5b").strip()
    installed = _installed_ollama()

    def _local_fallback(reason: str, requested: str | None = None) -> tuple[str, dict]:
        pick = None
        want = (requested or req or "").strip()
        if want in installed:
            pick = want
        elif want and ":" not in want:
            tagged = sorted(n for n in installed if n == want or n.startswith(want + ":"))
            if tagged:
                pick = tagged[0]
        if not pick:
            pick = _env("HUB_MODEL", "qwen2.5:0.5b")
        if pick not in installed:
            pick = _env("HUB_MODEL_FALLBACK", "qwen2.5:0.5b")
        if pick not in installed and installed:
            pick = sorted(installed)[0]
        return pick, {
            "requested": requested or req,
            "resolved": pick,
            "substituted": (requested or req) != pick,
            "via": "ollama",
            "prefer_local": True,
            "reason": reason,
        }

    # Private / local-first stack — never leave the node
    if prefer_local:
        return _local_fallback(
            "Private local stack — on-node model only (no network catalog).",
            requested=req if "/" not in req else None,
        )

    # Network mesh id (provider/model)
    if "/" in req:
        if not _network_configured():
            fallback = _env("HUB_MODEL", "qwen2.5:0.5b")
            return fallback, {
                "requested": req,
                "resolved": fallback,
                "substituted": True,
                "locked": True,
                "via": "ollama",
                "reason": "Network catalog key required for that model. Using on-node model.",
            }
        return req, {
            "requested": req,
            "resolved": req,
            "substituted": False,
            "network_id": req,
            "via": "network",
        }

    # Short aliases for common centralized defaults
    aliases = {
        "gpt-4o-mini": "openai/gpt-4o-mini",
        "gpt-4o": "openai/gpt-4o",
        "claude-sonnet-4": "anthropic/claude-sonnet-4",
    }
    if req in aliases and _network_configured():
        nid = aliases[req]
        return nid, {
            "requested": req,
            "resolved": nid,
            "substituted": False,
            "network_id": nid,
            "via": "network",
        }

    # Exact install only — family prefix must not claim larger variants are local
    if req in installed:
        return req, {"requested": req, "resolved": req, "substituted": False, "via": "ollama"}
    # Bare name without tag (e.g. tinyllama) → pick first tagged install of that family
    if ":" not in req:
        tagged = sorted(n for n in installed if n == req or n.startswith(req + ":"))
        if tagged:
            return tagged[0], {
                "requested": req,
                "resolved": tagged[0],
                "substituted": tagged[0] != req,
                "via": "ollama",
            }

    # Known node catalog but not installed → network if possible, else fallback
    node_ids = {m["id"] for m in NODE_CATALOG}
    if req in node_ids and _network_configured():
        # Try to find a network twin is hard; use default network model
        alt = _default_model_id()
        return alt, {
            "requested": req,
            "resolved": alt,
            "substituted": True,
            "network_id": alt,
            "via": "network",
            "reason": f"{req} not on this node — routed via network catalog.",
        }

    if status["backend"] == "remote":
        return req, {"requested": req, "resolved": req, "substituted": False, "via": "remote"}

    fallback = _env("HUB_MODEL", "qwen2.5:0.5b")
    if fallback not in installed:
        fallback = _env("HUB_MODEL_FALLBACK", "qwen2.5:0.5b")
    if fallback not in installed and installed:
        fallback = sorted(installed)[0]
    return fallback, {
        "requested": req,
        "resolved": fallback,
        "substituted": True,
        "via": "ollama",
        "reason": "Model not on this node — routed via installed Noeti model.",
    }


def _allow(ip: str, limit: int = 40, window: float = 3600.0) -> bool:
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate.get(ip, []) if now - t < window]
        if len(hits) >= limit:
            _rate[ip] = hits
            return False
        hits.append(now)
        _rate[ip] = hits
        return True


def _chat_network(messages: list[dict], model: str, temperature: float = 0.55) -> tuple[str, dict]:
    key = _network_key()
    if not key:
        raise RuntimeError("Network catalog API key is not set")
    url = f"{_network_base()}/chat/completions"
    headers = {
        "Authorization": f"Bearer {key}",
        "HTTP-Referer": _env("OPENROUTER_SITE_URL") or _env("PUBLIC_URL") or "https://noeticompute.com",
        "X-Title": _env("OPENROUTER_APP_NAME") or "Noeti Chat",
    }
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 2000,
    }
    try:
        data = _http_json(url, body, headers=headers, timeout=120)
    except urllib.error.HTTPError as exc:
        err_body = ""
        try:
            err_body = exc.read().decode("utf-8", errors="replace")[:400]
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"Network catalog HTTP {exc.code}: {err_body or exc.reason}") from exc
    text = (
        ((data.get("choices") or [{}])[0].get("message") or {}).get("content")
        or ""
    ).strip()
    if not text:
        raise RuntimeError("Empty response from network catalog")
    return text, {
        "provider": "network",
        "raw_model": data.get("model") or model,
        "usage": data.get("usage") or {},
    }


def _chat_golem(messages: list[dict], model: str, temperature: float = 0.55) -> tuple[str, dict]:
    base = _env("GOLEM_CHAT_BASE_URL").rstrip("/")
    key = _env("GOLEM_CHAT_API_KEY")
    url = f"{base}/chat/completions" if base.endswith("/v1") else f"{base}/v1/chat/completions"
    headers = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 1200,
    }
    data = _http_json(url, body, headers=headers, timeout=120)
    text = (
        ((data.get("choices") or [{}])[0].get("message") or {}).get("content")
        or ""
    ).strip()
    if not text:
        raise RuntimeError("Empty response from remote chat endpoint")
    return text, {"provider": "remote", "raw_model": data.get("model") or model}


def _chat_ollama(messages: list[dict], model: str, temperature: float = 0.55) -> tuple[str, dict]:
    host = _env("OLLAMA_HOST", "http://ollama:11434").rstrip("/")
    url = f"{host}/api/chat"
    body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature, "num_predict": 1200},
    }
    try:
        data = _http_json(url, body, timeout=180)
    except urllib.error.HTTPError as exc:
        alt = _env("HUB_MODEL_FALLBACK", "qwen2.5:0.5b")
        if alt and alt != model:
            body["model"] = alt
            data = _http_json(url, body, timeout=180)
            model = alt
        else:
            raise RuntimeError(f"Ollama HTTP {exc.code}") from exc
    text = ((data.get("message") or {}).get("content") or "").strip()
    if not text:
        raise RuntimeError("Empty response from Noeti node")
    return text, {"provider": "noeti-node", "raw_model": model}


def _related_sources(query: str, reply: str) -> list[dict]:
    sources: list[dict] = []
    seen: set[str] = set()
    blob = f"{query}\n{reply}"
    for m in re.finditer(r"https?://[^\s)\]\"']+", blob):
        url = m.group(0).rstrip(".,;")
        if url in seen:
            continue
        seen.add(url)
        sources.append({"title": url, "source": "link", "url": url, "kind": "url"})
    try:
        from news_mesh import get_news_items

        items = (get_news_items() or {}).get("items") or []
        qwords = {w.lower() for w in re.findall(r"[A-Za-z]{4,}", query)[:12]}
        scored: list[tuple[int, dict]] = []
        for it in items:
            title = str(it.get("title") or "")
            words = {w.lower() for w in re.findall(r"[A-Za-z]{4,}", title)}
            score = len(qwords & words)
            if score:
                scored.append((score, it))
        scored.sort(key=lambda x: -x[0])
        for score, it in scored[:6]:
            key = f"{it.get('source')}::{it.get('title')}"
            if key in seen:
                continue
            seen.add(key)
            real_url = (it.get("url") or it.get("link") or "").strip()
            if not real_url.startswith("http"):
                continue
            sources.append(
                {
                    "title": it.get("title"),
                    "source": it.get("source"),
                    "kind": "wire",
                    "score": score,
                    "url": real_url,
                }
            )
    except Exception:  # noqa: BLE001
        pass
    # No stub "Noeti" filler chips — only real URLs / wire hits.
    return sources[:8]


def _insights(query: str, reply: str, latency_ms: int, model: str) -> dict:
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", reply) if len(s.strip()) > 20]
    claimish = sentences[:5]
    return {
        "latency_ms": latency_ms,
        "model": model,
        "reply_chars": len(reply),
        "reply_words": len(reply.split()),
        "query_words": len(query.split()),
        "claim_candidates": claimish,
        "bars": [
            {"label": "Query", "value": min(100, len(query.split()) * 4)},
            {"label": "Reply", "value": min(100, max(8, len(reply.split()) // 2))},
            {"label": "Depth", "value": min(100, len(claimish) * 18 + 10)},
            {"label": "Speed", "value": max(5, 100 - min(95, latency_ms // 80))},
        ],
    }


def list_assistants() -> dict:
    return {"ok": True, "assistants": ASSISTANTS, "default": "default"}


def _web_search_blob(query: str, limit: int = 5) -> tuple[str, list[dict]]:
    """Lightweight search for optional web-grounding."""
    sources: list[dict] = []
    lines: list[str] = []
    try:
        from newsroom_workflow import search_internet

        for s in search_internet(query, limit=limit) or []:
            url = (s.get("url") or "").strip()
            title = s.get("title") or url
            snip = (s.get("snippet") or "")[:220]
            if not url.startswith("http"):
                continue
            sources.append({"title": title, "url": url, "snippet": snip, "kind": "web", "source": s.get("channel") or "web"})
            lines.append(f"- {title}\n  {url}\n  {snip}")
    except Exception:  # noqa: BLE001
        pass
    if not lines:
        try:
            from news_mesh import get_news_items

            items = (get_news_items() or {}).get("items") or []
            for it in items[:limit]:
                url = (it.get("url") or it.get("link") or "").strip()
                if not url.startswith("http"):
                    continue
                title = it.get("title") or url
                sources.append({"title": title, "url": url, "kind": "wire", "source": it.get("source")})
                lines.append(f"- {title}\n  {url}")
        except Exception:  # noqa: BLE001
            pass
    blob = "WEB RESULTS:\n" + ("\n".join(lines) if lines else "(none)")
    return blob, sources


def _normalize_content(content: Any) -> Any:
    """Allow multimodal OpenAI-style content arrays."""
    if isinstance(content, list):
        out = []
        for part in content[:12]:
            if not isinstance(part, dict):
                continue
            ptype = part.get("type")
            if ptype == "text":
                text = str(part.get("text") or "")[:8000]
                if text:
                    out.append({"type": "text", "text": text})
            elif ptype == "image_url":
                img = part.get("image_url") or {}
                url = img.get("url") if isinstance(img, dict) else None
                if isinstance(url, str) and (url.startswith("data:image/") or url.startswith("https://")):
                    # Cap data URLs
                    if url.startswith("data:image/") and len(url) > 2_500_000:
                        continue
                    out.append({"type": "image_url", "image_url": {"url": url}})
        return out or ""
    return str(content or "").strip()


def prepare_messages(
    messages: list[dict],
    *,
    assistant_id: str | None = None,
    system_prompt: str | None = None,
    web_search: bool = False,
) -> tuple[list[dict], str, list[dict]]:
    assistant = _ASSISTANTS_BY_ID.get(assistant_id or "default") or _ASSISTANTS_BY_ID["default"]
    sys_text = (system_prompt or "").strip() or assistant.get("system") or _SYSTEM
    clean: list[dict] = [{"role": "system", "content": sys_text}]
    last_user = ""
    web_sources: list[dict] = []
    for m in messages[-20:]:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = _normalize_content(m.get("content"))
        if not content:
            continue
        if isinstance(content, str) and len(content) > 8000:
            content = content[:8000]
        clean.append({"role": role, "content": content})
        if role == "user":
            if isinstance(content, str):
                last_user = content
            else:
                last_user = " ".join(
                    p.get("text") or "" for p in content if isinstance(p, dict) and p.get("type") == "text"
                )
    if web_search and last_user:
        blob, web_sources = _web_search_blob(last_user)
        # Insert grounding just before last user turn
        if len(clean) >= 2:
            clean.insert(-1, {"role": "system", "content": blob + "\n\nCite these URLs when used."})
    return clean, last_user, web_sources


def _stream_network(messages: list[dict], model: str, temperature: float = 0.55):
    key = _network_key()
    if not key:
        raise RuntimeError("Network catalog API key is not set")
    url = f"{_network_base()}/chat/completions"
    body = json.dumps(
        {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": 2000,
            "stream": True,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Authorization": f"Bearer {key}",
            "HTTP-Referer": _env("OPENROUTER_SITE_URL") or _env("PUBLIC_URL") or "https://noeticompute.com",
            "X-Title": _env("OPENROUTER_APP_NAME") or "Noeti Chat",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                data = json.loads(payload)
            except json.JSONDecodeError:
                continue
            delta = ((data.get("choices") or [{}])[0].get("delta") or {}).get("content") or ""
            if delta:
                yield delta, data.get("model") or model


def _stream_ollama(messages: list[dict], model: str, temperature: float = 0.55):
    host = _env("OLLAMA_HOST", "http://ollama:11434").rstrip("/")
    # Ollama multimodal expects images separately; flatten text for node models
    flat = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, list):
            text = " ".join(p.get("text") or "" for p in c if isinstance(p, dict) and p.get("type") == "text")
            flat.append({"role": m["role"], "content": text})
        else:
            flat.append({"role": m["role"], "content": c})
    body = json.dumps(
        {
            "model": model,
            "messages": flat,
            "stream": True,
            "options": {"temperature": temperature, "num_predict": 1200},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{host}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            delta = ((data.get("message") or {}).get("content")) or ""
            if delta:
                yield delta, model
            if data.get("done"):
                break


def stream_chat(
    messages: list[dict],
    client_ip: str = "unknown",
    model: str | None = None,
    temperature: float | None = None,
    *,
    assistant_id: str | None = None,
    system_prompt: str | None = None,
    web_search: bool = False,
    prefer_local: bool = False,
):
    """Yield SSE-ready dict events: meta, token, done, error."""
    if not _allow(client_ip):
        yield {"event": "error", "message": "Too many messages from this address. Try again later."}
        return

    temp = 0.55 if temperature is None else max(0.0, min(1.5, float(temperature)))
    # Private stack: no outbound web grounding
    if prefer_local:
        web_search = False
    clean, last_user, web_sources = prepare_messages(
        messages,
        assistant_id=assistant_id,
        system_prompt=system_prompt,
        web_search=web_search,
    )
    if len(clean) < 2:
        yield {"event": "error", "message": "Send a message."}
        return

    status = backend_status()
    resolved, resolve_meta = _resolve_model(model, prefer_local=prefer_local)
    via = resolve_meta.get("via")
    net_id = resolve_meta.get("network_id")
    use_network = (not prefer_local) and (via == "network" or (net_id and _network_configured() and via != "ollama"))
    use_remote = (not prefer_local) and (not use_network) and (status["backend"] == "remote" or via == "remote")

    yield {
        "event": "meta",
        "backend": "network" if use_network else ("remote" if use_remote else "noeti-node"),
        "label": (
            "Private local stack"
            if prefer_local
            else ("Noeti network catalog" if use_network else ("Noeti node" if not use_remote else status.get("label")))
        ),
        "model": net_id or resolved,
        "requested_model": resolve_meta.get("requested"),
        "substituted": bool(resolve_meta.get("substituted")),
        "substitute_reason": resolve_meta.get("reason"),
        "prefer_local": bool(prefer_local),
        "routing": "private_local" if prefer_local else ("network" if use_network else "node"),
        "assistant_id": assistant_id or "default",
        "web_search": bool(web_search),
        "web_sources": web_sources,
    }

    t0 = time.time()
    full = []
    used_model = net_id or resolved
    try:
        if use_network:
            gen = _stream_network(clean, net_id or resolved, temperature=temp)
        elif use_remote:
            # Non-streaming remote fallback as single chunk
            text, meta = _chat_golem(clean, resolved, temperature=temp)
            used_model = meta.get("raw_model") or resolved
            yield {"event": "token", "text": text}
            full.append(text)
            gen = iter(())
        else:
            gen = _stream_ollama(clean, resolved, temperature=temp)
        for delta, mid in gen:
            used_model = mid or used_model
            full.append(delta)
            yield {"event": "token", "text": delta}
    except Exception as exc:  # noqa: BLE001
        yield {"event": "error", "message": f"Compute path failed: {exc}"}
        return

    reply = "".join(full).strip()
    latency = int((time.time() - t0) * 1000)
    sources = web_sources + _related_sources(last_user, reply)
    # de-dupe urls
    seen = set()
    deduped = []
    for s in sources:
        u = s.get("url") or s.get("title")
        if u in seen:
            continue
        seen.add(u)
        deduped.append(s)
    yield {
        "event": "done",
        "ok": True,
        "reply": reply,
        "model": used_model,
        "latency_ms": latency,
        "temperature": temp,
        "sources": deduped[:10],
        "insights": _insights(last_user, reply, latency, used_model),
        "substituted": bool(resolve_meta.get("substituted")),
        "substitute_reason": resolve_meta.get("reason"),
        "note": "Public demo — do not paste confidential sources.",
    }


def chat(
    messages: list[dict],
    client_ip: str = "unknown",
    model: str | None = None,
    temperature: float | None = None,
    *,
    assistant_id: str | None = None,
    system_prompt: str | None = None,
    web_search: bool = False,
    prefer_local: bool = False,
) -> dict:
    # Collect stream into one response for non-streaming clients
    reply = ""
    meta_ev: dict = {}
    done_ev: dict = {}
    for ev in stream_chat(
        messages,
        client_ip=client_ip,
        model=model,
        temperature=temperature,
        assistant_id=assistant_id,
        system_prompt=system_prompt,
        web_search=web_search,
        prefer_local=prefer_local,
    ):
        if ev.get("event") == "error":
            return {"ok": False, "error": "backend", "message": ev.get("message")}
        if ev.get("event") == "meta":
            meta_ev = ev
        if ev.get("event") == "token":
            reply += ev.get("text") or ""
        if ev.get("event") == "done":
            done_ev = ev
    if not done_ev:
        return {"ok": False, "error": "backend", "message": "Empty response"}
    return {
        "ok": True,
        "reply": done_ev.get("reply") or reply,
        "backend": meta_ev.get("backend"),
        "label": meta_ev.get("label"),
        "model": done_ev.get("model") or meta_ev.get("model"),
        "requested_model": meta_ev.get("requested_model"),
        "substituted": bool(meta_ev.get("substituted")),
        "substitute_reason": meta_ev.get("substitute_reason"),
        "prefer_local": bool(meta_ev.get("prefer_local")),
        "routing": meta_ev.get("routing"),
        "latency_ms": done_ev.get("latency_ms"),
        "temperature": done_ev.get("temperature"),
        "sources": done_ev.get("sources"),
        "insights": done_ev.get("insights"),
        "assistant_id": meta_ev.get("assistant_id"),
        "web_search": meta_ev.get("web_search"),
        "note": done_ev.get("note"),
    }
