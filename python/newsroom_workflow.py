"""Newsroom workflow: internet search → sourcing graph → multi-model judges.

Primary worker model: smallest installed (qwen2.5:0.5b).
Judges: multiple roles across available Ollama models.
"""
from __future__ import annotations

import html as html_lib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

WORKER_MODEL = os.environ.get("WORKFLOW_WORKER_MODEL") or os.environ.get("HUB_MODEL") or "qwen2.5:0.5b"
JUDGE_MODELS = [
    {"id": "qwen2.5:0.5b", "role": "speed_judge", "label": "Speed judge (0.5B)"},
    {"id": "qwen2.5:1.5b", "role": "balance_judge", "label": "Balance judge (1.5B)"},
    {"id": "qwen2.5:0.5b", "role": "skeptic_judge", "label": "Skeptic judge (0.5B)"},
    {"id": "qwen2.5:1.5b", "role": "editor_judge", "label": "Editor judge (1.5B)"},
    {"id": "qwen2.5:0.5b", "role": "wire_judge", "label": "Wire judge (0.5B)"},
]
# Desk witness planes — independently selectable models in chat topbar
DESK_PLANES = [
    {"id": "qwen2.5:0.5b", "role": "checker", "label": "Checker"},
    {"id": "qwen2.5:1.5b", "role": "validator", "label": "Validator"},
    {"id": "qwen2.5:0.5b", "role": "watcher", "label": "Watcher"},
]

_JUDGE_PROMPTS = {
    "speed_judge": "You are a fast newsroom triage judge. Be brief. Verdict: supported|contested|unknown. One sentence why.",
    "balance_judge": "You are a balanced desk editor. Weigh sources carefully. Verdict: supported|contested|unknown. Cite which source helps.",
    "skeptic_judge": "You are a hostile skeptic. Prefer contested unless strong evidence. Verdict: supported|contested|unknown.",
    "editor_judge": "You are a publish-gate editor. Block contested claims. Verdict: supported|contested|unknown. Mention publish risk.",
    "wire_judge": "You are a wire-service checker. Prefer primary/record sources. Verdict: supported|contested|unknown.",
    "checker": (
        "You are the Checker. Verify concrete facts against sources. "
        "Reply in plain text only — no markdown, no asterisks, no headers. "
        "Format exactly: Verdict: supported|contested|unknown. Reason: one complete sentence."
    ),
    "validator": (
        "You are the Validator (publish gate). Decide if claims are safe to publish. "
        "Plain text only — no markdown. "
        "Format exactly: Verdict: supported|contested|unknown. Reason: one complete sentence about publish risk."
    ),
    "watcher": (
        "You are the Watcher. Hunt contradictions and weak spots. Prefer contested if unsure. "
        "Plain text only — no markdown. "
        "Format exactly: Verdict: supported|contested|unknown. Reason: one complete sentence."
    ),
}


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _ollama(messages: list[dict], model: str, num_predict: int = 280) -> str:
    host = _env("OLLAMA_HOST", "http://ollama:11434").rstrip("/")
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": num_predict},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{host}/api/chat",
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "NoetiWorkflow/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError:
        payload["model"] = "qwen2.5:0.5b"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{host}/api/chat",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = json.loads(resp.read().decode("utf-8", errors="replace"))
    return ((raw.get("message") or {}).get("content") or "").strip()


def _http_get(url: str, timeout: int = 12) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; NoetiDesk/1.0; +https://noeticompute.com)",
            "Accept": "text/html,application/json,*/*",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _http_post_form(url: str, form: dict, timeout: int = 15) -> str:
    data = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; NoetiDesk/1.0; +https://noeticompute.com)",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "text/html",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _resolve_public_url(url: str) -> str:
    """Map DuckDuckGo topic links to Wikipedia when possible."""
    u = (url or "").strip()
    m = re.match(r"https?://(?:www\.)?duckduckgo\.com/([^/?#]+)$", u, flags=re.I)
    if m:
        slug = urllib.parse.unquote(m.group(1))
        if slug and not slug.startswith(("c/", "l/", "?")):
            return "https://en.wikipedia.org/wiki/" + slug
    return u


def search_internet(query: str, limit: int = 8) -> list[dict]:
    """Web sources for Desk: Wikipedia + DDG Instant Answer + news mesh.

    Note: DDG HTML/Lite SERPs are often blocked from datacenter IPs (anomaly page),
    so we rely on APIs that still answer from the hub.
    """
    results: list[dict] = []
    seen: set[str] = set()
    q = (query or "").strip()
    if not q:
        return []

    def _add(title: str, url: str, snippet: str = "", channel: str = "web", source: str | None = None) -> None:
        url = _resolve_public_url(url)
        title = re.sub(r"\s+", " ", html_lib.unescape(title or "")).strip()
        if not url.startswith("http") or url in seen or len(title) < 3:
            return
        # skip pure DDG category hubs
        if "duckduckgo.com/c/" in url:
            return
        seen.add(url)
        row = {
            "title": title[:160],
            "url": url,
            "snippet": re.sub(r"\s+", " ", html_lib.unescape(snippet or "")).strip()[:280],
            "channel": channel,
        }
        if source:
            row["source"] = source
        results.append(row)

    # 1) Wikipedia OpenSearch — reliable from hub
    try:
        # Prefer a compact search phrase
        wiki_q = " ".join(re.findall(r"[A-Za-z0-9]{3,}", q)[:6]) or q[:80]
        for term in (wiki_q, q[:80]):
            raw = _http_get(
                "https://en.wikipedia.org/w/api.php?"
                + urllib.parse.urlencode(
                    {
                        "action": "opensearch",
                        "search": term,
                        "limit": 6,
                        "namespace": 0,
                        "format": "json",
                        "origin": "*",
                    }
                )
            )
            data = json.loads(raw)
            titles = data[1] if isinstance(data, list) and len(data) > 1 else []
            descs = data[2] if isinstance(data, list) and len(data) > 2 else []
            urls = data[3] if isinstance(data, list) and len(data) > 3 else []
            for i, title in enumerate(titles):
                _add(
                    title,
                    urls[i] if i < len(urls) else "",
                    descs[i] if i < len(descs) else "",
                    channel="wikipedia",
                    source="Wikipedia",
                )
            if len(results) >= 3:
                break
    except Exception:  # noqa: BLE001
        pass

    # 2) DuckDuckGo Instant Answer API
    try:
        data = json.loads(
            _http_get(
                "https://api.duckduckgo.com/?"
                + urllib.parse.urlencode(
                    {"q": q, "format": "json", "no_html": "1", "no_redirect": "1", "t": "noeti"}
                )
            )
        )
        if data.get("AbstractText") and data.get("AbstractURL"):
            _add(
                data.get("Heading") or "Instant answer",
                data["AbstractURL"],
                data["AbstractText"][:280],
                channel="ddg_instant",
            )

        def _walk(items: list) -> None:
            for item in items or []:
                if not isinstance(item, dict):
                    continue
                if item.get("FirstURL") and item.get("Text"):
                    _add(item.get("Text") or "", item.get("FirstURL") or "", item.get("Text") or "", channel="ddg_related")
                _walk(item.get("Topics") or [])

        _walk(data.get("RelatedTopics") or [])
    except Exception:  # noqa: BLE001
        pass

    # 3) Try DDG Lite (may be blocked — harmless if empty)
    if len(results) < max(3, limit // 2):
        try:
            page = _http_post_form("https://lite.duckduckgo.com/lite/", {"q": q})
            if "anomaly" not in page.lower() and "Unfortunately" not in page:
                for m in re.finditer(
                    r"href=['\"](https?://[^'\"]+)['\"][^>]*class=['\"]result-link['\"][^>]*>(.*?)</a>",
                    page,
                    flags=re.I | re.S,
                ):
                    title = re.sub(r"<[^>]+>", "", m.group(2))
                    _add(title, m.group(1), channel="web")
                    if len(results) >= limit:
                        break
                # Fallback pattern used by some DDG lite skins
                if len(results) < 3:
                    for m in re.finditer(
                        r"<a[^>]+rel=['\"]nofollow['\"][^>]+href=['\"](https?://[^'\"]+)['\"][^>]*>(.*?)</a>",
                        page,
                        flags=re.I | re.S,
                    ):
                        href = m.group(1)
                        if "duckduckgo.com" in href:
                            continue
                        title = re.sub(r"<[^>]+>", "", m.group(2))
                        _add(title, href, channel="web")
                        if len(results) >= limit:
                            break
        except Exception:  # noqa: BLE001
            pass

    # 3b) Wikipedia full-text search as extra fill
    if len(results) < max(3, limit // 2):
        try:
            raw = _http_get(
                "https://en.wikipedia.org/w/api.php?"
                + urllib.parse.urlencode(
                    {
                        "action": "query",
                        "list": "search",
                        "srsearch": q[:120],
                        "srlimit": 5,
                        "format": "json",
                        "origin": "*",
                    }
                )
            )
            data = json.loads(raw)
            for hit in ((data.get("query") or {}).get("search") or []):
                title = hit.get("title") or ""
                snip = re.sub(r"<[^>]+>", "", hit.get("snippet") or "")
                _add(
                    title,
                    "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
                    snip,
                    channel="wikipedia",
                    source="Wikipedia",
                )
                if len(results) >= limit:
                    break
        except Exception:  # noqa: BLE001
            pass

    # 4) Live news mesh with real URLs only
    try:
        from news_mesh import get_news_items

        qwords = {w.lower() for w in re.findall(r"[A-Za-z]{3,}", q)}
        items = (get_news_items() or {}).get("items") or []
        scored = []
        for it in items:
            title = str(it.get("title") or "")
            words = {w.lower() for w in re.findall(r"[A-Za-z]{3,}", title)}
            score = len(qwords & words)
            if score:
                scored.append((score, it))
        scored.sort(key=lambda x: -x[0])
        for score, it in scored[:4]:
            real_url = (it.get("url") or it.get("link") or "").strip()
            _add(
                str(it.get("title") or ""),
                real_url,
                f"Live wire · {it.get('source')} · score {score}",
                channel="news_mesh",
                source=str(it.get("source") or ""),
            )
            if len(results) >= limit:
                break
    except Exception:  # noqa: BLE001
        pass

    return results[:limit]


def atomize_query(text: str) -> list[str]:
    """Split into short factual claim atoms — never dump a whole recipe/reply."""
    blob = re.sub(r"\s+", " ", (text or "").strip())
    claims: list[str] = []

    def _push(line: str) -> None:
        line = re.sub(r"^[\-\*\d\.\)\]]+\s*", "", (line or "").strip())
        line = re.sub(r"[#*_`]+", "", line).strip()
        if 18 <= len(line) <= 220 and line not in claims:
            claims.append(line[:220])

    # Regex-first (Desk must stay snappy). Opt into LLM with NEWSROOM_ATOMIZE_LLM=1.
    if os.environ.get("NEWSROOM_ATOMIZE_LLM", "").strip() in {"1", "true", "yes"}:
        try:
            raw = _ollama(
                [
                    {
                        "role": "system",
                        "content": (
                            "Extract 3-5 atomic factual claims. One claim per line. "
                            "No numbering, no markdown, no recipes as a whole."
                        ),
                    },
                    {"role": "user", "content": blob[:3500]},
                ],
                WORKER_MODEL,
                num_predict=120,
            )
            for line in (raw or "").splitlines():
                _push(line)
                if len(claims) >= 5:
                    break
        except Exception:  # noqa: BLE001
            pass

    if len(claims) < 2:
        for s in re.split(r"(?<=[.!?])\s+", blob):
            _push(s)
            if len(claims) >= 5:
                break
    if not claims:
        claims = [blob[:180] or "No claim extracted"]
    return claims[:5]


def build_sourcing_graph(claims: list[str], sources: list[dict]) -> dict:
    """Newsroom graph with scored claim↔source linkages (not a full mesh)."""
    stop = {
        "that", "this", "with", "from", "have", "been", "were", "will", "your",
        "their", "about", "into", "than", "then", "them", "they", "what", "when",
        "where", "which", "while", "would", "could", "should", "there", "these",
        "those", "other", "some", "more", "most", "such", "only", "also", "just",
        "like", "over", "after", "before", "because", "through", "during", "each",
        "make", "made", "using", "used", "very", "much", "many", "http", "https",
        "www", "com", "org", "html", "recipe", "recipes", "guide", "how",
    }

    def tokens(text: str) -> set[str]:
        words = {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9-]{2,}", text or "")}
        return {w for w in words if w not in stop and len(w) >= 3}

    def score_link(claim: str, src: dict) -> tuple[float, set[str]]:
        title = src.get("title") or ""
        snip = src.get("snippet") or ""
        cw = tokens(claim)
        tw = tokens(title)
        sw = tokens(title + " " + snip)
        if not cw or not sw:
            return 0.0, set()
        shared = cw & sw
        title_hit = cw & tw
        # Title matches weigh more than snippet-only
        score = len(shared) * 1.0 + len(title_hit) * 1.6
        # Prefer denser relative overlap on short claims
        score += (len(shared) / max(len(cw), 1)) * 2.2
        channel = (src.get("channel") or "").lower()
        if "wiki" in channel:
            score += 0.4
        elif "news" in channel or "wire" in channel:
            score += 0.25
        return score, shared

    nodes: list[dict] = []
    edges: list[dict] = []
    nodes.append({"id": "desk", "type": "desk", "label": "Newsroom desk"})
    for i, c in enumerate(claims):
        cid = f"claim_{i + 1}"
        nodes.append({"id": cid, "type": "claim", "label": c[:80], "full": c})
        edges.append({"from": "desk", "to": cid, "rel": "investigates", "weight": 2})

    src_ids: list[str] = []
    for j, s in enumerate(sources):
        sid = f"src_{j + 1}"
        src_ids.append(sid)
        nodes.append(
            {
                "id": sid,
                "type": "source",
                "label": (s.get("title") or "source")[:70],
                "url": s.get("url"),
                "channel": s.get("channel"),
                "snippet": (s.get("snippet") or "")[:280],
                "full": (s.get("title") or "source"),
            }
        )
        channel = s.get("channel") or "web"
        ch_id = f"ch_{channel}"
        if not any(n["id"] == ch_id for n in nodes):
            nodes.append({"id": ch_id, "type": "channel", "label": channel})
            edges.append({"from": "desk", "to": ch_id, "rel": "uses_channel", "weight": 1})
        edges.append({"from": ch_id, "to": sid, "rel": "provides", "weight": 1})

    # Scored claim↔source: keep top links per claim + ensure every source has a best claim
    claim_links: dict[str, list[tuple[float, str, set[str]]]] = {f"claim_{i+1}": [] for i in range(len(claims))}
    src_best: dict[str, tuple[float, str, set[str]]] = {}
    for j, s in enumerate(sources):
        sid = src_ids[j]
        for i, c in enumerate(claims):
            cid = f"claim_{i + 1}"
            sc, shared = score_link(c, s)
            if sc <= 0:
                continue
            claim_links[cid].append((sc, sid, shared))
            prev = src_best.get(sid)
            if not prev or sc > prev[0]:
                src_best[sid] = (sc, cid, shared)

    linked: set[tuple[str, str]] = set()
    for cid, rows in claim_links.items():
        rows.sort(key=lambda x: x[0], reverse=True)
        # Keep strongest 3; require real signal (score >= 1.2) unless only weak hits
        kept = [r for r in rows if r[0] >= 1.2][:3]
        if not kept and rows:
            kept = rows[:1]
        for sc, sid, shared in kept:
            linked.add((sid, cid))
            rel = "supports" if sc >= 2.4 or len(shared) >= 2 else "related"
            edges.append(
                {
                    "from": sid,
                    "to": cid,
                    "rel": rel,
                    "weight": round(min(sc, 8.0), 2),
                    "overlap": sorted(list(shared))[:8],
                }
            )

    # Orphan sources still attach to their best claim (thin related edge)
    for sid, (sc, cid, shared) in src_best.items():
        if (sid, cid) in linked:
            continue
        edges.append(
            {
                "from": sid,
                "to": cid,
                "rel": "related",
                "weight": round(max(sc, 0.5), 2),
                "overlap": sorted(list(shared))[:6],
            }
        )

    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "claims": len(claims),
            "sources": len(sources),
            "edges": len(edges),
            "claim_source_links": sum(1 for e in edges if e.get("rel") in ("supports", "related")),
        },
    }


def _strip_md(text: str) -> str:
    t = re.sub(r"[#*_`]+", "", text or "")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _finish_sentence(text: str, limit: int = 320) -> str:
    """Trim cleanly at a sentence end — never mid-word / mid-hyphen."""
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return t

    def last_complete(s: str) -> str | None:
        best = -1
        for ch in ".!?":
            i = s.rfind(ch)
            if i > best:
                best = i
        if best >= 40:
            return s[: best + 1].strip()
        return None

    work = t[:limit] if len(t) > limit else t
    dangling = bool(re.search(r"[-—–]$", work))
    over = len(t) > limit
    # Only treat missing end-punct as truncated when the reason is long
    incomplete = over or dangling or (work[-1:] not in ".!?" and len(work) > 120)

    if incomplete:
        done = last_complete(work)
        if done:
            return done
        if dangling or over:
            clean = re.sub(r"\s+\S*[-—–]?$", "", work).rstrip(",;:*-—– ")
            if not clean:
                clean = work.rstrip(",;:*-—– ")
            done = last_complete(clean)
            if done:
                return done
            if clean and clean[-1:] not in ".!?":
                return clean + "…"
            return clean
        # Long text without punctuation: soft ellipsis, keep words
        if work[-1:] not in ".!?":
            return work.rstrip(",;: ") + "…"
    return t


def _parse_verdict(text: str) -> tuple[str, str, list[str]]:
    """Return (verdict, reason, steps). Steps may be empty when trail is off."""
    raw_full = text or ""
    raw = _strip_md(raw_full)
    low = raw.lower()
    if "contested" in low:
        v = "contested"
    elif "supported" in low:
        v = "supported"
    else:
        v = "unknown"

    steps: list[str] = []
    # Prefer an explicit Steps: … block before Reason:
    sm = re.search(
        r"(?is)\bsteps?\s*[:\-–]\s*(.+?)(?=\breason\s*[:\-–]|\bwhy\s*[:\-–]|$)",
        raw_full,
    )
    step_blob = sm.group(1).strip() if sm else ""
    if not step_blob:
        # Numbered lines anywhere: 1. … 2. …
        nums = re.findall(r"(?m)^\s*\d+[\.\)]\s+(.+)$", raw_full)
        if len(nums) >= 2:
            step_blob = "\n".join(nums)
    if step_blob:
        parts = re.split(r"(?:(?:^|\n)\s*\d+[\.\)]\s+|; |\n+)", step_blob)
        for p in parts:
            s = _strip_md(p)
            s = re.sub(r"(?i)^(verdict|reason|steps?)\s*[:\-–]?\s*", "", s).strip()
            s = _finish_sentence(s, 220)
            if len(s) >= 8:
                steps.append(s)
            if len(steps) >= 6:
                break

    reason = raw
    m = re.search(r"(?i)(?:reason|why)\s*[:\-–]\s*(.+)$", raw)
    if m:
        reason = m.group(1).strip()
    else:
        reason = re.sub(
            r"(?i)^\s*(verdict|decision)\s*[:\-–]?\s*(supported|contested|unknown)\s*[.\-]?\s*",
            "",
            raw,
        ).strip()
        reason = re.sub(r"(?i)\b(verdict|reason|steps?)\s*[:\-–]\s*", "", reason).strip()
        # If we extracted steps, drop them from reason body
        if steps:
            reason = re.sub(r"(?is)\bsteps?\s*[:\-–].*", "", reason).strip()
    if not reason or len(reason) < 8:
        reason = steps[-1] if steps else raw
    reason = re.sub(r"(?i)^(supported|contested|unknown)\s*[.\-:]?\s*", "", reason).strip()
    # Strip leftover step numbering from reason
    reason = re.sub(r"(?i)^steps?\s*[:\-–]?\s*", "", reason).strip()
    reason = _finish_sentence(reason, 320)
    return v, reason, steps


def judge_catalog() -> list[dict]:
    rows = list(JUDGE_MODELS) + list(DESK_PLANES)
    return [
        {
            **j,
            "prompt": _JUDGE_PROMPTS.get(j["role"], ""),
            "default_on": j["role"] in ("checker", "validator", "watcher")
            or j["role"] in {x["role"] for x in JUDGE_MODELS},
            "plane": j["role"] in ("checker", "validator", "watcher"),
        }
        for j in rows
    ]


def _is_local_ollama_id(model: str) -> bool:
    m = (model or "").strip()
    if not m:
        return True
    # OpenRouter-style ids contain a slash (mistralai/..., openai/...)
    if "/" in m:
        return False
    return True


def _judge_generate(system: str, user: str, model: str, num_predict: int = 280) -> str:
    """Run a short judge call on local Ollama or network catalog models."""
    mid = (model or WORKER_MODEL).strip() or WORKER_MODEL
    if _is_local_ollama_id(mid):
        return _ollama(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            mid,
            num_predict=num_predict,
        )
    from golem_chat import chat as gc_chat

    out = gc_chat(
        messages=[{"role": "user", "content": user[:6000]}],
        model=mid,
        temperature=0.15,
        system_prompt=system,
        assistant_id="default",
    )
    if not out.get("ok"):
        raise RuntimeError(out.get("message") or "Judge model failed")
    return (out.get("reply") or "").strip()


def _resolve_panel(
    enabled_roles: list[str] | None,
    model_overrides: dict[str, str] | None,
) -> list[dict]:
    overrides = {str(k): str(v).strip() for k, v in (model_overrides or {}).items() if v}
    by_role = {j["role"]: dict(j) for j in JUDGE_MODELS}
    for p in DESK_PLANES:
        by_role[p["role"]] = dict(p)
    desk_keys = {"checker", "validator", "watcher"}
    if overrides and (set(overrides) & desk_keys):
        roles = enabled_roles or ["checker", "validator", "watcher"]
    elif enabled_roles:
        roles = list(enabled_roles)
    else:
        roles = [j["role"] for j in JUDGE_MODELS]
    panel: list[dict] = []
    for role in roles:
        base = by_role.get(role)
        if not base:
            continue
        item = dict(base)
        if role in overrides and overrides[role]:
            item["id"] = overrides[role]
        panel.append(item)
    return panel or [dict(j) for j in JUDGE_MODELS]


def run_judges(
    claim: str,
    sources: list[dict],
    enabled_roles: list[str] | None = None,
    model_overrides: dict[str, str] | None = None,
    *,
    explain: bool = False,
) -> list[dict]:
    from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

    src_slice = sources[:6]
    src_blob = "\n".join(
        f"- {s.get('title')} ({s.get('channel') or s.get('source')}) {s.get('url')}\n  {s.get('snippet')}"
        for s in src_slice
    )
    saw = {
        "source_count": len(src_slice),
        "source_urls": [s.get("url") for s in src_slice if s.get("url")],
        "source_titles": [s.get("title") for s in src_slice if s.get("title")],
        "prompt_bytes": len(src_blob.encode("utf-8")),
    }
    panel = _resolve_panel(enabled_roles, model_overrides)
    # Keep Desk responsive — huge network models must not block the whole run
    judge_timeout = 16 if any("/" in str(j.get("id") or "") for j in panel) else 22

    def _one(j: dict) -> dict:
        prompt = _JUDGE_PROMPTS.get(j["role"], _JUDGE_PROMPTS["balance_judge"])
        if explain:
            prompt = (
                prompt
                + " When asked for a trail, also list Steps: 1. 2. 3. showing how you reached the verdict, "
                "then Reason: one complete sentence. Plain text only — no markdown."
            )
            user = (
                f"CLAIM:\n{claim}\n\nSOURCES:\n{src_blob or '(none)'}\n\n"
                "Reply in plain text only (no markdown, no asterisks).\n"
                "Format:\n"
                "Verdict: supported|contested|unknown\n"
                "Steps:\n"
                "1. What you checked first\n"
                "2. What a source said that mattered\n"
                "3. How that led to your verdict\n"
                "Reason: one complete sentence."
            )
            predict = 180
        else:
            user = (
                f"CLAIM:\n{claim}\n\nSOURCES:\n{src_blob or '(none)'}\n\n"
                "Reply in plain text only (no markdown, no asterisks). "
                "Use: Verdict: supported|contested|unknown. Reason: one complete sentence."
            )
            predict = 120
        t1 = time.time()
        try:
            ans = _judge_generate(prompt, user, j["id"], num_predict=predict)
            verdict, reason, steps = _parse_verdict(ans)
            ok, err = True, None
        except Exception as exc:  # noqa: BLE001
            verdict, reason, steps, ok, err = "unknown", "", [], False, str(exc)
        return {
            "model": j["id"],
            "role": j["role"],
            "label": j["label"],
            "verdict": verdict,
            "reason": reason,
            "steps": steps if explain else [],
            "explain": bool(explain),
            "ok": ok,
            "error": err,
            "latency_ms": int((time.time() - t1) * 1000),
            "saw": saw,
        }

    if not panel:
        return []

    out: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(3, len(panel))) as pool:
        futs = [pool.submit(_one, j) for j in panel]
        for fut, j in zip(futs, panel):
            try:
                out.append(fut.result(timeout=judge_timeout))
            except FuturesTimeout:
                out.append(
                    {
                        "model": j["id"],
                        "role": j["role"],
                        "label": j["label"],
                        "verdict": "unknown",
                        "reason": "Judge timed out — sources still mapped.",
                        "steps": [],
                        "explain": bool(explain),
                        "ok": False,
                        "error": "timeout",
                        "latency_ms": judge_timeout * 1000,
                        "saw": saw,
                    }
                )
            except Exception as exc:  # noqa: BLE001
                out.append(
                    {
                        "model": j["id"],
                        "role": j["role"],
                        "label": j["label"],
                        "verdict": "unknown",
                        "reason": "",
                        "steps": [],
                        "explain": bool(explain),
                        "ok": False,
                        "error": str(exc),
                        "latency_ms": 0,
                        "saw": saw,
                    }
                )
    return out


def aggregate_verdicts(judges: list[dict]) -> dict:
    counts = {"supported": 0, "contested": 0, "unknown": 0}
    for j in judges:
        counts[j.get("verdict") or "unknown"] = counts.get(j.get("verdict") or "unknown", 0) + 1
    # majority with skeptic bias: contested wins ties against supported
    if counts["contested"] >= counts["supported"] and counts["contested"] > 0:
        final = "contested"
    elif counts["supported"] > counts["contested"] and counts["supported"] > counts["unknown"]:
        final = "supported"
    elif counts["supported"] > 0 and counts["contested"] == 0:
        final = "supported"
    else:
        final = "unknown"
    gate = "blocked" if final == "contested" else ("ready" if final == "supported" else "review")
    return {"final_verdict": final, "counts": counts, "publish_gate": gate, "judge_count": len(judges)}


def run_workflow(
    query: str,
    enabled_roles: list[str] | None = None,
    *,
    private: bool = False,
    persist: bool = True,
    model_overrides: dict[str, str] | None = None,
    context: str | None = None,
    explain: bool = False,
) -> dict[str, Any]:
    q = (query or "").strip()
    ctx = (context or "").strip()
    # If the chat query is tiny, search/atomize from the assistant reply instead
    if len(q) < 12 and len(ctx) >= 12:
        first = re.split(r"(?<=[.!?])\s+", ctx)[0].strip()
        q = first[:280] if len(first) >= 12 else ctx[:280]
    if len(q) < 8:
        return {"ok": False, "error": "short", "message": "Query too short — send a fuller message."}
    if len(q) > 6000:
        q = q[:6000]
    if len(ctx) > 8000:
        ctx = ctx[:8000]
    want_trail = bool(explain)

    t0 = time.time()
    steps: list[dict] = []
    activity: list[dict] = []
    overrides = {str(k): str(v).strip() for k, v in (model_overrides or {}).items() if v}
    # Keep Desk snappy: demote flagship overrides to small local/fast defaults
    _heavy = re.compile(r"70b|72b|405b|deepseek-r1|opus|sonnet|gpt-4(?!o-mini)", re.I)
    _fast_local = "qwen2.5:0.5b"
    for _role in ("checker", "validator", "watcher"):
        mid = overrides.get(_role) or ""
        if mid and _heavy.search(mid):
            overrides[_role] = _fast_local if ":" in _fast_local else mid
    plane_active = bool(set(overrides) & {"checker", "validator", "watcher"}) or (
        enabled_roles is not None
        and any(r in ("checker", "validator", "watcher") for r in enabled_roles)
    )
    network_planes = any("/" in (overrides.get(r) or "") for r in ("checker", "validator", "watcher"))

    # Step 1 — search (skipped on private local path)
    t_s = time.time()
    if private:
        sources = []
        steps.append(
            {
                "id": "search",
                "label": "Private local — no public search",
                "ok": True,
                "count": 0,
                "private": True,
            }
        )
        activity.append(
            {
                "stage": "search",
                "actor": "private routing",
                "did": "Skipped internet/wire fetch (private local path)",
                "latency_ms": int((time.time() - t_s) * 1000),
            }
        )
    else:
        # Search both the user ask and a short reply seed when available
        sources = search_internet(q, limit=5)
        if len(sources) < 2 and ctx and ctx[:120] != q[:120]:
            extra = search_internet(ctx[:180], limit=4)
            seen = {s.get("url") for s in sources}
            for s in extra:
                if s.get("url") not in seen:
                    sources.append(s)
                    seen.add(s.get("url"))
                if len(sources) >= 8:
                    break
        steps.append({"id": "search", "label": "Internet + wire search", "ok": True, "count": len(sources)})
        activity.append(
            {
                "stage": "search",
                "actor": "internet + wire",
                "did": f"Fetched {len(sources)} sources",
                "latency_ms": int((time.time() - t_s) * 1000),
            }
        )

    # Step 2 — atomize (prefer reply context when Desk is verifying a chat answer)
    t_a = time.time()
    atom_src = ctx if len(ctx) > 40 else q
    claims = atomize_query(atom_src)
    steps.append(
        {
            "id": "atomize",
            "label": f"Atomize on {WORKER_MODEL}",
            "ok": True,
            "count": len(claims),
            "model": WORKER_MODEL,
        }
    )
    activity.append(
        {
            "stage": "atomize",
            "actor": WORKER_MODEL,
            "did": f"Split into {len(claims)} claim atom(s)",
            "latency_ms": int((time.time() - t_a) * 1000),
        }
    )

    # Step 3 — graph
    t_g = time.time()
    graph = build_sourcing_graph(claims, sources)
    steps.append({"id": "graph", "label": "Newsroom sourcing graph", "ok": True, **graph["stats"]})
    activity.append(
        {
            "stage": "graph",
            "actor": "sourcing chain",
            "did": f"Built {graph['stats']['edges']} edges across {graph['stats']['sources']} sources",
            "latency_ms": int((time.time() - t_g) * 1000),
        }
    )

    # Step 4 — multi-model judges / Desk planes per claim
    roles_for_run = enabled_roles
    if plane_active and not enabled_roles:
        roles_for_run = ["checker", "validator", "watcher"]
    claim_cap = 1 if network_planes else (2 if plane_active else 4)
    claim_results = []
    used_roles: list[str] = []
    for claim in claims[:claim_cap]:
        judges = run_judges(
            claim,
            sources,
            enabled_roles=roles_for_run,
            model_overrides=overrides or None,
            explain=want_trail,
        )
        for j in judges:
            used_roles.append(j["role"])
            activity.append(
                {
                    "stage": "judge",
                    "actor": j["label"],
                    "model": j["model"],
                    "role": j["role"],
                    "did": f"Judged claim → {j['verdict']}",
                    "verdict": j["verdict"],
                    "reason": j["reason"],
                    "steps": j.get("steps") or [],
                    "claim": claim[:160],
                    "latency_ms": j.get("latency_ms"),
                    "saw": j.get("saw"),
                }
            )
        agg = aggregate_verdicts(judges)
        claim_results.append({"claim": claim, "judges": judges, "aggregate": agg})
        activity.append(
            {
                "stage": "aggregate",
                "actor": "publish gate",
                "did": f"Aggregate → {agg['final_verdict']} ({agg['publish_gate']})",
                "verdict": agg["final_verdict"],
                "claim": claim[:160],
            }
        )
    panel_models = sorted({j["model"] for row in claim_results for j in row["judges"]})
    steps.append(
        {
            "id": "judges",
            "label": "Desk planes" if plane_active else "Multi-model judge panel",
            "ok": True,
            "models": panel_models,
            "roles": list(dict.fromkeys(used_roles)),
            "claims_judged": len(claim_results),
            "model_overrides": overrides,
        }
    )

    contested = sum(1 for c in claim_results if c["aggregate"]["final_verdict"] == "contested")
    supported = sum(1 for c in claim_results if c["aggregate"]["final_verdict"] == "supported")
    gate = "blocked" if contested else ("ready" if supported else "review")

    result = {
        "ok": True,
        "query": q,
        "worker_model": WORKER_MODEL,
        "routing": "private_local" if private else "public_search",
        "judge_catalog": judge_catalog(),
        "enabled_roles": list(dict.fromkeys(used_roles)),
        "desk_planes": {
            "checker": overrides.get("checker") or next((p["id"] for p in DESK_PLANES if p["role"] == "checker"), ""),
            "validator": overrides.get("validator") or next((p["id"] for p in DESK_PLANES if p["role"] == "validator"), ""),
            "watcher": overrides.get("watcher") or next((p["id"] for p in DESK_PLANES if p["role"] == "watcher"), ""),
        },
        "steps": steps,
        "activity": activity,
        "sources": sources,
        "claims": claims,
        "graph": graph,
        "judgements": claim_results,
        "explain": want_trail,
        "summary": {
            "supported": supported,
            "contested": contested,
            "unknown": len(claim_results) - supported - contested,
            "publish_gate": gate,
        },
        "latency_ms": int((time.time() - t0) * 1000),
        "note": (
            "Private local path — no public search; draft only, not publish-ready."
            if private
            else "Public demo workflow — do not paste confidential sources."
        ),
    }
    try:
        from proofpath_packet import attach_to_workflow

        return attach_to_workflow(result, private=private, persist=persist)
    except Exception:  # noqa: BLE001
        return result
