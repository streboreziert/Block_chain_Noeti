"""Network hub — register compute nodes, dispatch inference, consensus, blockchain."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from chain_state import (
    MIN_STAKE,
    add_to_mempool,
    credit_tx,
    get_balance,
    has_minimum_stake,
    validate_transaction,
)
from crypto_wallet import Wallet, get_or_create_wallet, save_wallet
from gossip_mesh import get_mesh
from inference_chain import finalize_on_chain, get_chain
from mlc import get_balances
from prompt_complexity import (
    model_tier,
    resolve_model_for_tier,
    score_prompt,
    tier_rank,
)
from staking import slash_outliers, stake_requirements
from validators import known_validators
from models.task import TaskResult, TaskSummary
from reward import calculate_rewards, pick_consensus
from utils.ollama_client import NOETI_SYSTEM_PREAMBLE, OllamaClient, OllamaError
from utils.protocol import normalize_response

COMPUTE_TTL = 45.0
TASK_TIMEOUT = 120.0
DEFAULT_MODEL = "qwen2.5:0.5b"
SITE_HEARTBEAT_SEC = 20.0
SITE_POLL_SEC = 2.0
COORDINATOR_HEARTBEAT_N = int(os.environ.get("COORDINATOR_HEARTBEATS", "10"))
COORDINATOR_TOP_K = 3
SITE_WALLET_PATH = Path(__file__).parent / "data" / "site_wallet.json"
SITE_ENC_PATH = Path(__file__).parent / "data" / "site_enc.json"


def normalize_runtime(runtime: str | None) -> str:
    value = (runtime or "").strip().lower()
    return value if value in {"ollama", "browser"} else "ollama"


def hub_blind() -> bool:
    """When on (default), ollama/desktop tasks require enc_pubkey; hub wipes plaintext after encrypt."""
    return os.environ.get("HUB_BLIND", "1").strip().lower() in {"1", "true", "yes", "on"}


def mesh_consensus() -> bool:
    """When on, verified/earn settlement needs ≥2 distinct node results (chat fast stays quorum=1)."""
    return os.environ.get("MESH_CONSENSUS", "0").strip().lower() in {"1", "true", "yes", "on"}


def clamp_max_tokens(value: Any, default: int | None = None) -> int | None:
    """Clamp chat max_tokens / num_predict to 128–2048."""
    if value is None or value == "":
        return default
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(128, min(2048, n))


def _strip_html(text: str) -> str:
    text = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", text)
    text = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"&\w+;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


_WEB_BLOCK_MARKERS = (
    "bots use duckduckgo",
    "captcha",
    "challenge",
    "unusual traffic",
    "please complete the following",
    "anomaly-modal",
    "challenge-form",
)

_TIME_QUESTION_RE = re.compile(
    r"\b(what\s+(day|date|time)|current\s+(day|date|time)|today'?s?\s+date|"
    r"what\s+day\s+is\s+it|timezone|utc\s+time)\b",
    re.I,
)

_SPORTS_INTENT_RE = re.compile(
    r"\b("
    r"fifa|world\s*cup|uefa|champions\s*league|premier\s*league|la\s*liga|"
    r"bundesliga|serie\s*a|mls|nba|nfl|mlb|nhl|ncaa|olympics?|tennis|"
    r"match(\s+today)?|score(s|board)?|result(s)?|fixture(s)?|kick\s*off|"
    r"semifinals?|quarter-?finals?|final|knockout|group\s+stage"
    r")\b",
    re.I,
)

_SCORE_OR_DATE_RE = re.compile(
    r"("
    r"\b\d+\s*[-–:]\s*\d+\b|"
    r"\b\d+\s*\(\d+[-–]\d+\s*pens?\)|"
    r"\b(won|beat|defeated|draw|pens?|et|a\.?e\.?t\.?)\b|"
    r"\b(round of \d+|group [a-l]|semi-?final|quarter-?final|final)\b|"
    r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|"
    r"nov(?:ember)?|dec(?:ember)?)\b|"
    r"\b20\d{2}\b"
    r")",
    re.I,
)

_SPORTS_PAGE_HOSTS = (
    "espn.com",
    "fifa.com",
    "wikipedia.org",
    "bbc.com",
    "bbc.co.uk",
    "skysports.com",
    "goal.com",
    "cbssports.com",
    "foxsports.com",
    "reuters.com",
    "apnews.com",
)

# Live scores / results — news backends. Speculative Sporting News roundups stay off
# schedule/hosts/teams questions (they confuse finals with other tournaments).
_LIVE_SPORTS_SCORES_RE = re.compile(
    r"\b("
    r"today|yesterday|latest|live\s+score|score(s|board)?|"
    r"who\s+won|winner|result(s)?|"
    r"updated\s+scores?"
    r")\b",
    re.I,
)

_SPORTS_FACTS_RE = re.compile(
    r"\b("
    r"how\s+many\s+teams|how\s+many\s+countries|team\s+count|"
    r"where\s+(is|are|will|was)|when\s+(is|are|will|was)|"
    r"which\s+countr|host(s|ed|ing)?|venue|held|schedule|dates?|"
    r"expanded\s+to"
    r")\b",
    re.I,
)

# Canonical Wikipedia titles for known tournaments — fetched BEFORE generic search.
_KNOWN_WIKI_TOPICS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"\b((20)?26\s+)?(fifa\s+)?world\s*cup\b|\bfifa\s*2026\b", re.I),
        "2026_FIFA_World_Cup",
    ),
)


def _looks_like_bot_challenge(text: str) -> bool:
    low = (text or "").lower()
    return any(m in low for m in _WEB_BLOCK_MARKERS)


def build_time_context() -> str:
    """Authoritative UTC clock for all workers — injected even when internet is off."""
    now = datetime.now(timezone.utc)
    lines = [
        "[time context]",
        f"Today is {now.strftime('%A, %d %B %Y')}.",
        f"UTC date: {now.strftime('%A, %d %B %Y')}",
        f"UTC time: {now.strftime('%H:%M')} UTC",
    ]
    try:
        local = datetime.now().astimezone()
        tz_name = local.tzname() or (str(local.tzinfo) if local.tzinfo else "")
        if tz_name:
            lines.append(f"Hub timezone: {tz_name}")
    except Exception:
        pass
    return "\n".join(lines)


def _web_headers(*, html: bool = False) -> dict[str, str]:
    if html:
        return {
            "User-Agent": (
                "Mozilla/5.0 (compatible; NoetiHub/0.5.35; +https://noeticompute.com)"
            ),
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        }
    return {
        "User-Agent": "NoetiHub/0.5.35 (+https://noeticompute.com; research context)",
        "Accept": "application/json, text/plain, */*",
    }


def _wants_live_sports_scores(query: str) -> bool:
    """True only for latest scores / who-won-today — not schedule/hosts/teams facts."""
    q = query or ""
    if not _SPORTS_INTENT_RE.search(q):
        return False
    if _SPORTS_FACTS_RE.search(q):
        return False
    return bool(_LIVE_SPORTS_SCORES_RE.search(q))


def _canonical_wiki_title_for_query(query: str) -> str | None:
    """Map known intents (e.g. World Cup 2026) to a fixed Wikipedia REST title."""
    q = query or ""
    low = q.lower()
    year_m = re.search(r"\b(20\d{2})\b", q)
    year = year_m.group(1) if year_m else None
    if "world cup" in low or "fifa" in low:
        # Prefer explicit year; default 2026 for undated FIFA World Cup questions.
        y = year or "2026"
        if y == "2026" or (
            year is None and any(p.search(q) for p, _ in _KNOWN_WIKI_TOPICS)
        ):
            return f"{y}_FIFA_World_Cup"
        if year:
            return f"{year}_FIFA_World_Cup"
    for pat, title in _KNOWN_WIKI_TOPICS:
        if pat.search(q):
            return title
    return None


def _fetch_wikipedia_summary_title(
    title: str, *, timeout: float
) -> tuple[str, str] | None:
    """Fetch Wikipedia REST summary for an exact article title. Returns (display, extract)."""
    slug = title.replace(" ", "_")
    summary_url = (
        "https://en.wikipedia.org/api/rest_v1/page/summary/"
        + urllib.parse.quote(slug)
    )
    try:
        summary = json.loads(_http_get(summary_url, timeout=timeout))
    except Exception as exc:
        print(f"[web] wikipedia title summary failed ({slug}): {exc}")
        return None
    extract = str(summary.get("extract") or "").strip()
    if not extract or _looks_like_bot_challenge(extract):
        return None
    display = str(summary.get("title") or title.replace("_", " ")).strip()
    return display, extract


def _format_wiki_source(display_title: str, extract: str) -> str:
    return f"Source: Wikipedia — {display_title}\n{extract}"


def _http_get(url: str, *, timeout: float, html: bool = False) -> str:
    req = urllib.request.Request(url, headers=_web_headers(html=html))
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")



def _looks_like_junk_snippet(text: str) -> bool:
    low = (text or "").lower()
    if not text or len(text) < 20:
        return True
    bad = (
        '"wt":',
        'wt":',
        "mw-parser-output",
        "{{",
        "template",
        "infobox",
        "navbox",
        "wikidata",
        "cite_note",
        "ref name",
        "{|",
        "style=",
        "class=",
        "javascript",
        "cookie",
        "subscribe",
        "sign in",
        "/span>",
        "}}],",
    )
    return any(b in low for b in bad)


def _line_quality(text: str) -> int:
    """Higher is better — prefer snippets that mention scores/dates."""
    t = (text or "").strip()
    if len(t) < 24:
        return 0
    if _looks_like_junk_snippet(t):
        return 0
    score = 1
    if _SCORE_OR_DATE_RE.search(t):
        score += 3
    if re.search(r"\b\d+\s*[-–]\s*\d+\b", t):
        score += 4
    if re.search(r"\b(20\d{2}|july|june|today|yesterday)\b", t, re.I):
        score += 1
    return score


def _dedupe_lines(lines: list[str], *, limit: int = 8) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    ranked = sorted(
        (( _line_quality(x), i, x) for i, x in enumerate(lines)),
        key=lambda row: (-row[0], row[1]),
    )
    for qual, _i, line in ranked:
        if qual <= 0:
            continue
        key = re.sub(r"\s+", " ", line.lower())[:160]
        if key in seen:
            continue
        seen.add(key)
        out.append(line if line.startswith("- ") else f"- {line}")
        if len(out) >= limit:
            break
    return out


def _rewrite_search_queries(query: str) -> list[str]:
    """Entity-focused variants — sports NL prompts often miss Instant Answer / OpenSearch."""
    q = " ".join(str(query or "").split())[:240]
    if not q:
        return []
    variants: list[str] = [q]
    low = q.lower()
    year_m = re.search(r"\b(20\d{2})\b", q)
    year = year_m.group(1) if year_m else None
    live = _wants_live_sports_scores(q)

    if _SPORTS_INTENT_RE.search(q) or "fifa" in low or "world cup" in low:
        if "fifa" in low or "world cup" in low:
            y = year or "2026"
            if live:
                sports_q = [
                    f"{y} FIFA World Cup latest results scores",
                    f"{y} FIFA World Cup scores today",
                    f"{y} FIFA World Cup results",
                    f"{y} FIFA World Cup knockout stage",
                    f"{y} FIFA World Cup",
                ]
                if re.search(r"\b(won|winner|champion|final)\b", low):
                    sports_q.insert(0, f"{y} FIFA World Cup final")
                    sports_q.insert(0, f"Who won the {y} FIFA World Cup")
            else:
                # Schedule / hosts / teams — stay on the tournament article, not score junk.
                sports_q = [
                    f"{y} FIFA World Cup",
                    f"{y} FIFA World Cup hosts teams",
                    f"{y} FIFA World Cup venues",
                ]
            variants.extend(sports_q)
        else:
            variants.append(re.sub(r"\b(who won|what was|tell me)\b", "", q, flags=re.I).strip())
            if live:
                if year:
                    variants.append(f"{q} {year} results scores")
                else:
                    variants.append(f"{q} latest results scores")

    # Drop empty / dupes while preserving order
    out: list[str] = []
    seen: set[str] = set()
    for v in variants:
        v = " ".join(v.split())[:240]
        key = v.lower()
        if not v or key in seen:
            continue
        seen.add(key)
        out.append(v)
    return out[:6]


def _fetch_ddg_instant(query: str, *, timeout: float) -> list[str]:
    url = "https://api.duckduckgo.com/?" + urllib.parse.urlencode(
        {"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"}
    )
    raw = _http_get(url, timeout=timeout)
    if _looks_like_bot_challenge(raw):
        print("[web] ddg instant answer rejected: captcha/challenge page")
        return []
    data = json.loads(raw)
    if not isinstance(data, dict):
        return []
    lines: list[str] = []
    abstract = str(data.get("AbstractText") or data.get("Abstract") or "").strip()
    heading = str(data.get("Heading") or "").strip()
    answer = str(data.get("Answer") or "").strip()
    if answer:
        lines.append(answer)
    if abstract:
        lines.append(f"{heading}: {abstract}" if heading else abstract)
    related = data.get("RelatedTopics") or []
    if isinstance(related, list):
        for item in related:
            if not isinstance(item, dict):
                continue
            if item.get("Text"):
                lines.append(str(item["Text"]).strip())
            for sub in item.get("Topics") or []:
                if isinstance(sub, dict) and sub.get("Text"):
                    lines.append(str(sub["Text"]).strip())
            if len(lines) >= 8:
                break
    return [x for x in lines if x]


def _wiki_title_rank(title: str, query: str) -> int:
    """Prefer tournament/results pages over side articles (controversies, albums, etc.)."""
    t = (title or "").lower()
    q = (query or "").lower()
    score = 0
    if "controvers" in t or "album" in t or "task force" in t or "official" in t:
        score -= 8
    if "world cup" in t or "fifa" in t:
        score += 4
    if any(k in t for k in ("knockout", "final", "result", "group", "qualification")):
        score += 5
    if re.search(r"\b20\d{2}\b", t) and re.search(r"\b20\d{2}\b", q):
        ym = re.search(r"\b(20\d{2})\b", q)
        if ym and ym.group(1) in t:
            score += 3
    # Exact-ish main tournament article
    if re.fullmatch(r"20\d{2} fifa world cup", t):
        score += 6
    return score


def _fetch_wikipedia(query: str, *, timeout: float) -> list[str]:
    lines: list[str] = []
    # Full-text search is more reliable than OpenSearch for NL sports prompts.
    search_url = (
        "https://en.wikipedia.org/w/api.php?"
        + urllib.parse.urlencode(
            {
                "action": "query",
                "list": "search",
                "srsearch": query,
                "srlimit": 8,
                "format": "json",
            }
        )
    )
    try:
        data = json.loads(_http_get(search_url, timeout=timeout))
        hits = (((data or {}).get("query") or {}).get("search")) or []
        titles = [str(h.get("title") or "").strip() for h in hits if h.get("title")]
    except Exception:
        titles = []
    if not titles:
        os_url = (
            "https://en.wikipedia.org/w/api.php?"
            + urllib.parse.urlencode(
                {
                    "action": "opensearch",
                    "search": query,
                    "limit": 5,
                    "namespace": 0,
                    "format": "json",
                }
            )
        )
        data = json.loads(_http_get(os_url, timeout=timeout))
        titles = [str(t) for t in (data[1] if isinstance(data, list) and len(data) > 1 else [])]

    titles = sorted(titles, key=lambda t: _wiki_title_rank(t, query), reverse=True)

    for title in titles[:4]:
        got = _fetch_wikipedia_summary_title(title.replace(" ", "_"), timeout=timeout)
        if got:
            display, extract = got
            lines.append(_format_wiki_source(display, extract))
    return lines


def _fetch_direct_sports_sources(query: str, *, timeout: float) -> list[str]:
    """Score-oriented FIFA/World Cup pages. Sporting News only when user asks live scores."""
    low = (query or "").lower()
    if "fifa" not in low and "world cup" not in low:
        return []
    year_m = re.search(r"\b(20\d{2})\b", query)
    year = year_m.group(1) if year_m else "2026"
    live = _wants_live_sports_scores(query)
    titles = [
        f"{year} FIFA World Cup",
        f"{year} FIFA World Cup knockout stage",
    ]
    if live:
        titles.append(f"{year} FIFA World Cup final")
    lines: list[str] = []
    for title in titles:
        got = _fetch_wikipedia_summary_title(title.replace(" ", "_"), timeout=timeout)
        if got:
            display, extract = got
            lines.append(_format_wiki_source(display, extract))
        if not live:
            continue
        # HTML extract for score lines (summaries omit match scores)
        page_url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(
            title.replace(" ", "_")
        )
        try:
            raw = _http_get(page_url, timeout=timeout + 1.0, html=True)
            lines.extend(_extract_scoreful_excerpts(raw, limit=4))
        except Exception as exc:
            print(f"[web] wiki page extract failed ({title}): {exc}")
    # Speculative Sporting News roundups — live scores only (can confuse finals/hosts).
    if live:
        sn_candidates = [
            "https://www.sportingnews.com/us/soccer/news/world-cup-results-2026-updated-scores-today-yesterday-2026/0aac196507c2f55a95cff893",
        ]
        for sn in sn_candidates:
            try:
                raw = _http_get(sn, timeout=timeout + 1.5, html=True)
                got = _extract_scoreful_excerpts(raw, limit=5)
                if got:
                    print("[web] sportingnews ok")
                    lines.append("Source: Sporting News — scores")
                    lines.extend(got)
                    break
            except Exception as exc:
                print(f"[web] sportingnews failed: {exc}")
    return lines


def _fetch_wikidata(query: str, *, timeout: float) -> list[str]:
    url = (
        "https://www.wikidata.org/w/api.php?"
        + urllib.parse.urlencode(
            {
                "action": "wbsearchentities",
                "search": query,
                "language": "en",
                "limit": 3,
                "format": "json",
            }
        )
    )
    data = json.loads(_http_get(url, timeout=timeout))
    lines: list[str] = []
    for item in data.get("search") or []:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()
        desc = str(item.get("description") or "").strip()
        if label and desc:
            lines.append(f"{label}: {desc}")
        elif label:
            lines.append(label)
    return lines


def _fetch_ddg_html(query: str, *, timeout: float) -> tuple[list[str], list[str]]:
    """Parse DuckDuckGo HTML lite results. Returns (snippets, result_urls)."""
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    raw = _http_get(url, timeout=timeout, html=True)
    if _looks_like_bot_challenge(raw):
        print("[web] ddg html rejected: captcha/challenge page")
        return [], []
    snippets: list[str] = []
    for m in re.finditer(
        r'class="result__snippet[^"]*"[^>]*>(.*?)</(?:a|td|span)',
        raw,
        re.I | re.S,
    ):
        text = _strip_html(m.group(1)).strip()
        if text:
            snippets.append(text)
    if not snippets:
        for m in re.finditer(r'class="result__snippet">(.*?)</a>', raw, re.I | re.S):
            text = _strip_html(m.group(1)).strip()
            if text:
                snippets.append(text)
    titles: list[str] = []
    for m in re.finditer(r'class="result__a[^"]*"[^>]*>(.*?)</a>', raw, re.I | re.S):
        text = _strip_html(m.group(1)).strip()
        if text:
            titles.append(text)
    # Pair title + snippet when useful
    paired: list[str] = []
    for i, snip in enumerate(snippets[:10]):
        title = titles[i] if i < len(titles) else ""
        paired.append(f"{title}: {snip}" if title else snip)

    urls: list[str] = []
    for m in re.finditer(r'uddg=([^&"]+)', raw):
        try:
            u = urllib.parse.unquote(m.group(1))
        except Exception:
            continue
        if u.startswith("http") and "duckduckgo.com" not in u:
            urls.append(u)
    # de-dupe urls
    seen_u: set[str] = set()
    uniq_urls: list[str] = []
    for u in urls:
        if u in seen_u:
            continue
        seen_u.add(u)
        uniq_urls.append(u)
    return paired, uniq_urls


def _extract_scoreful_excerpts(page_text: str, *, limit: int = 6) -> list[str]:
    clean = _strip_html(page_text)
    clean = re.sub(r"\s+", " ", clean).strip()
    if not clean or _looks_like_bot_challenge(clean):
        return []
    hits: list[str] = []
    # Prefer human scorelines: Team 2-1 Team / Team 2 , Team 1
    patterns = (
        r".{0,40}\b[A-Z][A-Za-z.]*(?:\s[A-Z][A-Za-z.]*){0,3}\s+\d+\s*[-–,]"
        r"\s*(?:\d+\s*)?[A-Za-z].{0,40}",
        r".{0,50}\b\d+\s*[-–]\s*\d+\b.{0,50}",
    )
    for pat in patterns:
        for m in re.finditer(pat, clean):
            chunk = m.group(0).strip(" .-|,;:")
            if _looks_like_junk_snippet(chunk):
                continue
            if not _SCORE_OR_DATE_RE.search(chunk):
                continue
            hits.append(chunk)
            if len(hits) >= limit * 3:
                break
        if len(hits) >= limit:
            break
    return _dedupe_lines(hits, limit=limit)


def _fetch_sports_pages(urls: list[str], *, timeout: float) -> list[str]:
    lines: list[str] = []
    for u in urls:
        host = urllib.parse.urlparse(u).netloc.lower().removeprefix("www.")
        if not any(host.endswith(h) for h in _SPORTS_PAGE_HOSTS):
            continue
        try:
            raw = _http_get(u, timeout=timeout, html=True)
        except Exception as exc:
            print(f"[web] page fetch failed ({host}): {exc}")
            continue
        excerpts = _extract_scoreful_excerpts(raw, limit=5)
        if excerpts:
            print(f"[web] page ok: {host} ({len(excerpts)} excerpts)")
            lines.extend(excerpts)
        if len(lines) >= 8:
            break
    return lines


def fetch_web_context(query: str, *, timeout: float = 6.0) -> str | None:
    """Live web facts via Wikipedia (primary), Instant Answer, DDG, Wikidata, sports pages.

    Returns a short context string, or None on failure. Never returns captcha HTML.
    Known topics (e.g. World Cup 2026) always lead with a labeled Wikipedia extract.
    Schedule/hosts/teams → Wikipedia; latest scores → news backends.
    """
    q = " ".join(str(query or "").split())[:240]
    if not q:
        return None

    variants = _rewrite_search_queries(q)
    per = max(2.5, min(timeout, 5.0))
    primary_blocks: list[str] = []
    collected: list[str] = []
    page_urls: list[str] = []
    sports = bool(_SPORTS_INTENT_RE.search(q))
    live_scores = _wants_live_sports_scores(q)

    # 0) Canonical Wikipedia title FIRST for known topics (World Cup 2026, etc.)
    canon = _canonical_wiki_title_for_query(q)
    if canon:
        try:
            got = _fetch_wikipedia_summary_title(canon, timeout=per + 1.0)
            if got:
                display, extract = got
                primary_blocks.append(_format_wiki_source(display, extract))
                print(f"[web] primary wikipedia ok: {display}")
        except Exception as exc:
            print(f"[web] primary wikipedia failed: {exc}")

    # Facts-only sports (hosts/teams/schedule): Wikipedia extract is enough — skip news junk.
    if sports and not live_scores and primary_blocks:
        return "\n\n".join(primary_blocks)[:2200]

    # Facts path fallback if canonical title missed: Wikipedia search only (no Sporting News).
    if sports and not live_scores and not primary_blocks:
        for v in variants[:3]:
            try:
                got = _fetch_wikipedia(v, timeout=per)
                if got:
                    return "\n\n".join(got[:2])[:2200]
            except Exception as exc:
                print(f"[web] wikipedia facts fallback failed: {exc}")
        try:
            got = _fetch_direct_sports_sources(q, timeout=per + 1.0)
            wiki_only = [x for x in got if str(x).startswith("Source: Wikipedia")]
            if wiki_only:
                return "\n\n".join(wiki_only[:2])[:2200]
        except Exception as exc:
            print(f"[web] direct wiki facts fallback failed: {exc}")

    # 1) DuckDuckGo Instant Answer (often empty for sports/news — keep as fast path)
    for v in variants[:3]:
        try:
            got = _fetch_ddg_instant(v, timeout=per)
            if got:
                collected.extend(got)
                break
        except Exception as exc:
            print(f"[web] ddg instant answer failed: {exc}")
    if not collected and not primary_blocks:
        print("[web] ddg instant answer empty — trying wikipedia / html")

    # 2) Wikipedia search API + REST summary (supplement when no canonical primary)
    if not primary_blocks:
        for v in variants[:3]:
            try:
                got = _fetch_wikipedia(v, timeout=per)
                if got:
                    # First hit is already labeled; keep as primary block when possible
                    primary_blocks.append(got[0])
                    collected.extend(got[1:])
                    break
            except Exception as exc:
                print(f"[web] wikipedia failed: {exc}")

    # 3) DuckDuckGo HTML lite — live scores / non-sports only (skip for WC facts)
    if live_scores or not sports:
        html_query = variants[0]
        if sports and live_scores and len(variants) > 1:
            html_query = next(
                (v for v in variants if "result" in v.lower() or "score" in v.lower()),
                variants[1],
            )
        try:
            snippets, urls = _fetch_ddg_html(html_query, timeout=per + 1.0)
            # Drop Sporting News noise from generic HTML unless explicitly live scores
            if not live_scores:
                snippets = [
                    s
                    for s in snippets
                    if "sportingnews" not in s.lower() and "sporting news" not in s.lower()
                ]
                urls = [
                    u
                    for u in urls
                    if "sportingnews.com" not in urllib.parse.urlparse(u).netloc.lower()
                ]
            collected.extend(snippets)
            page_urls.extend(urls)
        except Exception as exc:
            print(f"[web] ddg html failed: {exc}")

    # 4) Wikidata entity descriptions (fallback grounding)
    if not primary_blocks and len(_dedupe_lines(collected, limit=8)) < 2:
        for v in variants[:2]:
            try:
                got = _fetch_wikidata(v, timeout=per)
                if got:
                    collected.extend(got)
                    break
            except Exception as exc:
                print(f"[web] wikidata failed: {exc}")

    # 5) Live scores: follow top result pages for score-rich text
    if sports and live_scores and page_urls:
        try:
            collected.extend(_fetch_sports_pages(page_urls[:6], timeout=per + 1.5))
        except Exception as exc:
            print(f"[web] sports page scrape failed: {exc}")

    # 5b) Direct FIFA/World Cup sources when live scores are thin
    if sports and live_scores and (
        not page_urls
        or not any(re.search(r"\b\d+\s*[-–]\s*\d+\b", x) for x in collected)
    ):
        try:
            collected.extend(_fetch_direct_sports_sources(q, timeout=per + 1.0))
        except Exception as exc:
            print(f"[web] direct sports sources failed: {exc}")

    # 6) Optional clock API for explicit time questions
    if _TIME_QUESTION_RE.search(q) and not primary_blocks and not collected:
        try:
            clock = json.loads(
                _http_get("https://worldtimeapi.org/api/ip", timeout=per)
            )
            if isinstance(clock, dict):
                bits = []
                if clock.get("datetime"):
                    bits.append(f"datetime={clock['datetime']}")
                if clock.get("timezone"):
                    bits.append(f"timezone={clock['timezone']}")
                if clock.get("day_of_week") != "" and clock.get("day_of_week") is not None:
                    bits.append(f"day_of_week={clock['day_of_week']}")
                if bits:
                    collected.append("World Time API: " + ", ".join(bits))
        except Exception as exc:
            print(f"[web] worldtimeapi failed: {exc}")

    # Keep labeled primary sources at the top; do not let score junk outrank them.
    parts: list[str] = []
    parts.extend(primary_blocks)
    extra = _dedupe_lines(
        [x for x in collected if not str(x).startswith("Source: Wikipedia")],
        limit=6 if primary_blocks else 8,
    )
    if extra:
        parts.append("\n".join(extra))
    if parts:
        return "\n\n".join(parts)[:2200]

    print("[web] all sources failed")
    return None



@dataclass
class NetworkEvent:
    timestamp: float
    kind: str
    message: str
    node_id: str | None = None
    task_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "time": datetime.fromtimestamp(self.timestamp).strftime("%H:%M:%S"),
            "kind": self.kind,
            "message": self.message,
            "node_id": self.node_id,
            "task_id": self.task_id,
        }


@dataclass
class TrafficFlow:
    ts: float
    kind: str
    from_id: str
    to_id: str
    task_id: str | None = None
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ts": self.ts,
            "kind": self.kind,
            "from": self.from_id,
            "to": self.to_id,
            "task_id": self.task_id,
            "detail": self.detail,
        }


@dataclass
class RelayRegistration:
    relay_id: str
    last_seen: float = field(default_factory=time.time)
    status: str = "online"
    last_action: str = "Relay online"
    tasks_relayed: int = 0
    address: str = ""
    client_ip: str = ""
    access_url: str = ""

    def __post_init__(self) -> None:
        self.address = self.relay_id

    def touch(self) -> None:
        self.last_seen = time.time()

    def is_online(self) -> bool:
        return (time.time() - self.last_seen) <= COMPUTE_TTL

    def to_dict(self) -> dict[str, Any]:
        return {
            "relay_id": self.relay_id,
            "node_id": self.relay_id,
            "role": "relay",
            "status": "online" if self.is_online() else "offline",
            "last_action": self.last_action,
            "tasks_relayed": self.tasks_relayed,
            "address": self.address,
            "client_ip": self.client_ip,
            "access_url": self.access_url,
            "last_seen": self.last_seen,
        }


@dataclass
class ComputeRegistration:
    node_id: str
    model: str
    wallet_address: str = ""
    enc_pubkey: str = ""
    role: str = "compute"
    roles: list[str] = field(default_factory=lambda: ["compute"])
    runtime: str = "ollama"
    last_seen: float = field(default_factory=time.time)
    status: str = "online"
    last_action: str = "Joined network"
    tasks_completed: int = 0
    address: str = ""
    client_ip: str = ""
    access_url: str = ""
    heartbeat_count: int = 0
    coordinator_explicit: bool = False

    def __post_init__(self) -> None:
        self.address = self.wallet_address or self.node_id
        self.runtime = normalize_runtime(self.runtime)
        if not self.roles:
            self.roles = ["compute"]

    def touch(self) -> None:
        self.last_seen = time.time()

    def is_online(self) -> bool:
        return (time.time() - self.last_seen) <= COMPUTE_TTL

    def capability_tier(self) -> str:
        return model_tier(self.model)

    def to_dict(self) -> dict[str, Any]:
        balances = {row["address"]: row for row in get_balances()}
        wallet = balances.get(self.wallet_address, {})
        roles = list(self.roles) if self.roles else [self.role or "compute"]
        return {
            "node_id": self.node_id,
            "worker_id": self.node_id,
            "model": self.model,
            "role": self.role,
            "roles": roles,
            "capability_tier": self.capability_tier(),
            "runtime": normalize_runtime(self.runtime),
            "address": self.address,
            "wallet_address": self.wallet_address,
            "enc_pubkey": self.enc_pubkey,
            "mlc_address": self.wallet_address,
            "mlc_balance": wallet.get("balance", 0.0),
            "mlc_staked": wallet.get("staked", 0.0),
            "status": "online" if self.is_online() else "offline",
            "last_action": self.last_action,
            "tasks_completed": self.tasks_completed,
            "heartbeat_count": self.heartbeat_count,
            "client_ip": self.client_ip,
            "access_url": self.access_url,
            "last_seen": self.last_seen,
        }


@dataclass
class ActiveTask:
    task_id: str
    prompt: str
    created: float
    prompt_hash: str = ""
    assigned: set[str] = field(default_factory=set)
    results: list[TaskResult] = field(default_factory=list)
    done: bool = False
    relay_pending: bool = True
    relay_id: str | None = None
    ready_for_compute: bool = False
    enc_by_node: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Winner decrypt / multi-assign hold — never returned by get_task.
    _prompt_hold: str = ""
    # node_id → encrypted response envelope (or plaintext hold for browser exception)
    response_blob_by_node: dict[str, dict[str, Any]] = field(default_factory=dict)
    runtime: str = "ollama"
    complexity: int = 0
    tokens_est: int = 0
    tier: str = "tiny"
    preferred_model: str = ""
    score_reasons: list[str] = field(default_factory=list)
    # Chat spend settings: fast = finalize after 1 result; verified = majority (≤3).
    mode: str = "verified"
    internet: bool = False
    web_context: bool = False
    num_predict: int | None = None
    # None → use min(online, 3); 1 for fast mode.
    quorum_target: int | None = None

    def __post_init__(self) -> None:
        self.runtime = normalize_runtime(self.runtime)

    def prompt_for_assign(self) -> str:
        return self.prompt or self._prompt_hold


class NetworkHub:
    def __init__(self, hub_id: str = "hub-01", model: str = DEFAULT_MODEL) -> None:
        self.hub_id = hub_id
        self.model = model
        self._ollama = OllamaClient(model=model)
        self._compute: dict[str, ComputeRegistration] = {}
        self._wallet_by_worker: dict[str, str] = {}
        self._relays: dict[str, RelayRegistration] = {}
        self._tasks: dict[str, ActiveTask] = {}
        self._events: list[NetworkEvent] = []
        self._flows: list[TrafficFlow] = []
        self._events_lock = threading.Lock()
        self._lock = threading.Lock()
        self._stats: list[TaskSummary] = []
        self.running_tasks: set[str] = set()
        self.running_task: str | None = None  # compat: any active id
        self.last_error: str | None = None
        self._resolved_model: str | None = None
        self.last_task_assignment: dict[str, Any] | None = None
        self.last_route: dict[str, Any] | None = None
        self._route_history: list[dict[str, Any]] = []
        self.role = "hub"
        self.max_active_tasks = int(os.environ.get("NOETIS_MAX_ACTIVE_TASKS", "8"))
        self.site_node_id = os.environ.get("SITE_COMPUTE_ID", "site-01")
        self._site_wallet: Wallet | None = None
        self._site_enc_pubkey: str = ""
        self._site_enc_privkey: str = ""
        self._site_thread: threading.Thread | None = None
        self._site_stop = threading.Event()
        self._site_last_heartbeat = 0.0

    def _log(self, kind: str, message: str, *, node_id: str | None = None, task_id: str | None = None) -> None:
        with self._events_lock:
            self._events.append(
                NetworkEvent(time.time(), kind, message, node_id=node_id, task_id=task_id)
            )
            self._events[:] = self._events[-200:]

    def _flow(
        self,
        kind: str,
        from_id: str,
        to_id: str,
        *,
        task_id: str | None = None,
        detail: str = "",
    ) -> None:
        with self._events_lock:
            self._flows.append(
                TrafficFlow(
                    ts=time.time(),
                    kind=kind,
                    from_id=from_id,
                    to_id=to_id,
                    task_id=task_id,
                    detail=detail,
                )
            )
            self._flows[:] = self._flows[-100:]

    def bootstrap(self) -> dict[str, Any]:
        if self._ollama.is_available():
            try:
                self._resolved_model = self._ollama.resolve_model(
                    [self.model, "qwen2.5:1.5b", "qwen2.5:0.5b", "llama3.2:1b", "phi3:mini"]
                )
            except OllamaError:
                self._resolved_model = None
        else:
            self._resolved_model = None

        online = self.online_compute()
        if online:
            self._log("network", f"Hub online — {len(online)} compute node(s) connected")
            return {"ok": True, "model": self._resolved_model, "compute_nodes": len(online)}

        if self._resolved_model:
            self._log(
                "network",
                f"Hub online — site compute ready · {self._resolved_model}",
            )
            return {
                "ok": True,
                "model": self._resolved_model,
                "compute_nodes": 0,
                "site_fallback": True,
            }

        self.last_error = "No compute online. Join as compute, or install Ollama on this machine."
        return {"ok": False, "error": self.last_error}

    def _load_or_create_site_wallet(self) -> Wallet:
        if self._site_wallet is not None:
            return self._site_wallet
        if SITE_WALLET_PATH.exists():
            payload = json.loads(SITE_WALLET_PATH.read_text())
            wallet = Wallet(
                name=payload.get("name", "site-compute"),
                address=payload["address"],
                public_key_hex=payload["public_key"],
                private_key_hex=payload["private_key_hex"],
            )
            self._site_wallet = wallet
            return wallet
        wallet = get_or_create_wallet("site-compute")
        SITE_WALLET_PATH.parent.mkdir(parents=True, exist_ok=True)
        SITE_WALLET_PATH.write_text(
            json.dumps(
                {
                    "name": wallet.name,
                    "address": wallet.address,
                    "public_key": wallet.public_key_hex,
                    "private_key_hex": wallet.private_key_hex,
                },
                indent=2,
            )
        )
        SITE_WALLET_PATH.chmod(0o600)
        try:
            save_wallet(wallet)
        except Exception:
            pass
        self._site_wallet = wallet
        return wallet

    def _load_or_create_site_enc(self) -> tuple[str, str]:
        """X25519 keys for site-01 blind tasks (internal; not the public faucet)."""
        if self._site_enc_pubkey and self._site_enc_privkey:
            return self._site_enc_pubkey, self._site_enc_privkey
        from task_crypto import generate_enc_keypair

        if SITE_ENC_PATH.exists():
            payload = json.loads(SITE_ENC_PATH.read_text())
            pub = str(payload.get("enc_pubkey", "")).strip()
            priv = str(payload.get("enc_privkey", "")).strip()
            if pub and priv:
                self._site_enc_pubkey, self._site_enc_privkey = pub, priv
                return pub, priv
        pub, priv = generate_enc_keypair()
        SITE_ENC_PATH.parent.mkdir(parents=True, exist_ok=True)
        SITE_ENC_PATH.write_text(
            json.dumps({"enc_pubkey": pub, "enc_privkey": priv}, indent=2)
        )
        SITE_ENC_PATH.chmod(0o600)
        self._site_enc_pubkey, self._site_enc_privkey = pub, priv
        return pub, priv

    def _ensure_site_staked(self, wallet: Wallet, node_id: str) -> None:
        """Internal treasury credit + stake ≥ MIN_STAKE (not the public faucet API)."""
        state = get_chain().current_state()
        if has_minimum_stake(state, wallet.address, node_id):
            return

        bal = get_balance(state, wallet.address)
        if bal["total"] < MIN_STAKE or bal["balance"] + bal["staked"] < MIN_STAKE:
            get_chain().add_state_block(
                [
                    credit_tx(
                        to_address=wallet.address,
                        amount=100.0,
                        reason="Site compute bootstrap",
                    )
                ],
                data=f"Site internal treasury credit — {node_id}",
            )
            state = get_chain().current_state()

        if has_minimum_stake(state, wallet.address, node_id):
            return

        row = get_balance(state, wallet.address)
        need = MIN_STAKE
        if row["balance"] < need:
            get_chain().add_state_block(
                [
                    credit_tx(
                        to_address=wallet.address,
                        amount=round(need - row["balance"] + 1.0, 6),
                        reason="Site compute stake top-up",
                    )
                ],
                data=f"Site stake top-up — {node_id}",
            )
            state = get_chain().current_state()
            row = get_balance(state, wallet.address)

        stake_tx = wallet.sign_transaction(
            {
                "type": "stake",
                "from": wallet.address,
                "amount": MIN_STAKE,
                "node_id": node_id,
                "nonce": int(row["nonce"]),
                "timestamp": time.time(),
            }
        )
        get_chain().add_state_block([stake_tx], data=f"Site stake — {node_id}")
        self._log("stake", f"Site compute staked {MIN_STAKE} MLC for {node_id}", node_id=node_id)

    def ensure_site_compute(self) -> dict[str, Any]:
        """Always-on site node (site-01): coordinator + compute that earns when Ollama is up."""
        if not self._ollama.is_available():
            return {"ok": False, "error": "Ollama unavailable — site compute not started"}

        try:
            self._resolved_model = self._ollama.resolve_model(
                [self.model, "qwen2.5:1.5b", "qwen2.5:0.5b", "llama3.2:1b", "phi3:mini"]
            )
        except OllamaError as exc:
            return {"ok": False, "error": str(exc)}

        node_id = self.site_node_id
        wallet = self._load_or_create_site_wallet()
        self._ensure_site_staked(wallet, node_id)
        enc_pubkey, _enc_priv = self._load_or_create_site_enc()

        result = self.register_compute(
            node_id,
            model=self._resolved_model or self.model,
            wallet_address=wallet.address,
            enc_pubkey=enc_pubkey,
            runtime="ollama",
            coordinator=True,
            roles=["coordinator", "compute"],
        )

        if self._site_thread is None or not self._site_thread.is_alive():
            self._site_stop.clear()
            self._site_thread = threading.Thread(
                target=self._site_loop,
                name=f"site-compute-{node_id}",
                daemon=True,
            )
            self._site_thread.start()
            self._log(
                "network",
                f"Site compute online: {node_id} · {self._resolved_model} · earns as coordinator+compute",
                node_id=node_id,
            )

        return {
            "ok": True,
            "node_id": node_id,
            "wallet": wallet.address,
            "model": self._resolved_model,
            **result,
        }

    def _site_loop(self) -> None:
        node_id = self.site_node_id
        while not self._site_stop.is_set():
            try:
                now = time.time()
                if now - self._site_last_heartbeat >= SITE_HEARTBEAT_SEC:
                    try:
                        self.heartbeat(node_id)
                    except ValueError:
                        self.ensure_site_compute()
                    self._site_last_heartbeat = now

                # Mesh-first: try open offers → claim, then poll fallback.
                payload = None
                offers = self.list_open_offers(node_id)
                if offers:
                    try:
                        payload = self.claim_task(node_id, str(offers[0]["task_id"]))
                    except ValueError:
                        payload = None
                if payload is None:
                    payload = self.poll_task(node_id)
                if payload:
                    self._run_site_task(node_id, payload)
            except Exception as exc:
                self._log("error", f"Site compute loop: {exc}", node_id=node_id)
            self._site_stop.wait(SITE_POLL_SEC)

    def _run_site_task(self, node_id: str, payload: dict[str, Any]) -> None:
        from attestation import build_attestation
        from proof_hash import sha256_text
        from task_crypto import decrypt_task, encrypt_response

        task_id = str(payload.get("task_id", ""))
        preferred = ""
        with self._lock:
            task = self._tasks.get(task_id)
            preferred = (task.preferred_model if task else "") or ""

        prompt = str(payload.get("prompt") or "")
        if payload.get("encrypted"):
            if not self._site_enc_privkey:
                self._load_or_create_site_enc()
            try:
                prompt = decrypt_task(payload, self._site_enc_privkey)
            except Exception as exc:
                self._log(
                    "error",
                    f"Site cannot decrypt encrypted task {task_id}: {exc}",
                    node_id=node_id,
                    task_id=task_id,
                )
                return
        if not prompt:
            self._log("error", f"Empty prompt for site task {task_id}", node_id=node_id, task_id=task_id)
            return

        result, counts = self._local_infer(
            node_id, task_id, prompt, preferred_model=preferred or None
        )
        attestation = None
        wallet = self._site_wallet
        if wallet is not None:
            try:
                attestation = build_attestation(
                    wallet,
                    task_id=task_id,
                    model=result.model,
                    response=result.response,
                    inference_ms=result.inference_ms,
                    prompt_hash=sha256_text(prompt),
                )
            except Exception:
                attestation = None

        if counts:
            with self._lock:
                if self.last_route and self.last_route.get("task_id") == task_id:
                    self.last_route = {**self.last_route, **counts}
                    self._route_history = [
                        {**row, **counts} if row.get("task_id") == task_id else row
                        for row in self._route_history
                    ]

        body_response = result.response
        enc_fields: dict[str, Any] = {}
        if payload.get("encrypted") and payload.get("ephem_pubkey") and self._site_enc_privkey:
            try:
                enc_fields = encrypt_response(
                    result.response, str(payload["ephem_pubkey"]), self._site_enc_privkey
                )
                body_response = ""
            except Exception:
                enc_fields = {}

        self.submit_result(
            task_id=task_id,
            node_id=node_id,
            response=body_response,
            inference_ms=result.inference_ms,
            model=result.model,
            attestation=attestation,
            response_encrypted=bool(enc_fields.get("response_encrypted")),
            response_ciphertext=str(enc_fields.get("response_ciphertext", "")),
            response_nonce=str(enc_fields.get("response_nonce", "")),
        )

    def online_relays(self) -> list[RelayRegistration]:
        with self._lock:
            return [relay for relay in self._relays.values() if relay.is_online()]

    def register_relay(self, relay_id: str, *, client_ip: str = "", access_url: str = "") -> dict[str, Any]:
        relay_id = relay_id.strip()
        if not relay_id:
            raise ValueError("relay_id required")

        with self._lock:
            relay = self._relays.get(relay_id)
            if relay is None:
                relay = RelayRegistration(relay_id=relay_id)
                self._relays[relay_id] = relay
            relay.touch()
            relay.status = "online"
            relay.last_action = "Routing layer active"
            if client_ip:
                relay.client_ip = client_ip
            if access_url:
                relay.access_url = access_url.strip().rstrip("/")

        self._log("join", f"Relay joined: {relay_id}", node_id=relay_id)
        self._flow("join", from_id=relay_id, to_id="hub", detail="relay join")
        return {"ok": True, "relay_id": relay_id, "address": relay.address, "hub": self.hub_id}

    def relay_heartbeat(self, relay_id: str) -> dict[str, Any]:
        with self._lock:
            relay = self._relays.get(relay_id)
            if relay is None:
                raise ValueError("Not registered — call /api/relay/register first")
            relay.touch()
        return {"ok": True}

    def poll_relay_task(self, relay_id: str) -> dict[str, Any] | None:
        with self._lock:
            relay = self._relays.get(relay_id)
            if relay is None:
                raise ValueError("Not registered")
            relay.touch()

            for task in self._tasks.values():
                if task.done or not task.relay_pending or task.relay_id is not None:
                    continue
                task.relay_id = relay_id
                relay.status = "routing"
                relay.last_action = f"Relaying {task.task_id}"
                # Relays never need plaintext under hub-blind — forward by id only.
                return {
                    "task_id": task.task_id,
                    "prompt": "" if hub_blind() else task.prompt_for_assign(),
                    "prompt_hash": task.prompt_hash,
                    "anonymous": True,
                }
        return None

    def forward_relay_task(self, relay_id: str, task_id: str) -> dict[str, Any]:
        with self._lock:
            relay = self._relays.get(relay_id)
            task = self._tasks.get(task_id)
            if relay is None:
                raise ValueError("Relay not registered")
            if task is None or task.done:
                raise ValueError("Task not found")
            if task.relay_id != relay_id:
                raise ValueError("Task not assigned to this relay")

            task.relay_pending = False
            task.ready_for_compute = True
            relay.status = "online"
            relay.last_action = f"Forwarded {task_id} to compute pool"
            relay.tasks_relayed += 1
            relay.touch()

        self._log(
            "relay",
            f"user/chat → hub → compute via relay={relay_id} task={task_id}",
            node_id=relay_id,
            task_id=task_id,
        )
        self._flow(
            "relay_forward",
            from_id=f"relay:{relay_id}",
            to_id="compute:pool",
            task_id=task_id,
            detail="anonymous forward",
        )
        return {"ok": True, "task_id": task_id}

    def _auto_relay_if_needed(self, task_id: str) -> None:
        if self.online_relays():
            return
        self._forward_relay_task_internal(task_id, "hub-relay")

    def _forward_relay_task_internal(self, task_id: str, relay_id: str) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or task.done:
                return
            task.relay_id = relay_id
            task.relay_pending = False
            task.ready_for_compute = True
        self._log(
            "relay",
            f"Task {task_id} auto-routed via hub relay (no external relay online)",
            task_id=task_id,
        )

    def online_compute(self) -> list[ComputeRegistration]:
        with self._lock:
            return [node for node in self._compute.values() if node.is_online()]

    def online_compute_for_runtime(self, runtime: str | None) -> list[ComputeRegistration]:
        rt = normalize_runtime(runtime)
        return [node for node in self.online_compute() if normalize_runtime(node.runtime) == rt]

    def runtime_counts(self) -> dict[str, int]:
        online = self.online_compute()
        ollama_n = sum(1 for n in online if normalize_runtime(n.runtime) == "ollama")
        browser_n = sum(1 for n in online if normalize_runtime(n.runtime) == "browser")
        return {"ollama": ollama_n, "browser": browser_n}

    def pick_task_runtime(self) -> str:
        counts = self.runtime_counts()
        if counts["ollama"] > 0:
            return "ollama"
        if counts["browser"] > 0:
            return "browser"
        return "ollama"

    def register_compute(
        self,
        node_id: str,
        model: str,
        wallet_address: str = "",
        enc_pubkey: str = "",
        *,
        client_ip: str = "",
        access_url: str = "",
        runtime: str = "ollama",
        coordinator: bool = False,
        roles: list[str] | None = None,
    ) -> dict[str, Any]:
        node_id = node_id.strip()
        wallet_address = wallet_address.strip()
        enc_pubkey = enc_pubkey.strip()
        runtime = normalize_runtime(runtime)
        if not node_id:
            raise ValueError("node_id required")
        if not wallet_address:
            raise ValueError("wallet_address required — create with: python3 wallet_cli.py create")

        state = get_chain().current_state()
        if not has_minimum_stake(state, wallet_address, node_id):
            req = stake_requirements(state, wallet_address, node_id)
            raise ValueError(req["message"])

        role_list = list(roles) if roles else ["compute"]
        if coordinator and "coordinator" not in role_list:
            role_list = ["coordinator", *role_list]
        if "compute" not in role_list:
            role_list.append("compute")
        if node_id == self.site_node_id:
            role_list = ["coordinator", "compute"]
            coordinator = True

        with self._lock:
            node = self._compute.get(node_id)
            if node is None:
                node = ComputeRegistration(
                    node_id=node_id,
                    model=model or self.model,
                    wallet_address=wallet_address,
                    enc_pubkey=enc_pubkey,
                    runtime=runtime,
                    roles=role_list,
                    coordinator_explicit=coordinator,
                )
                self._compute[node_id] = node
            node.model = model or node.model
            node.wallet_address = wallet_address
            node.enc_pubkey = enc_pubkey or node.enc_pubkey
            node.runtime = runtime
            node.address = wallet_address
            node.roles = role_list
            node.role = "coordinator" if "coordinator" in role_list else "compute"
            node.coordinator_explicit = node.coordinator_explicit or coordinator
            node.touch()
            node.status = "online"
            node.last_action = (
                f"Staked ≥{MIN_STAKE} MLC · {runtime} · roles={','.join(role_list)}"
            )
            if client_ip:
                node.client_ip = client_ip
            if access_url:
                node.access_url = access_url.strip().rstrip("/")
            self._wallet_by_worker[node_id] = wallet_address

        self._log(
            "join",
            f"Compute node joined: {node_id} ({runtime}) roles={','.join(role_list)} ({wallet_address[:16]}…)",
            node_id=node_id,
        )
        self._flow("join", from_id=f"compute:{node_id}", to_id="hub", detail=f"runtime={runtime}")
        return {
            "ok": True,
            "node_id": node_id,
            "address": node.address,
            "wallet_address": wallet_address,
            "enc_pubkey": node.enc_pubkey,
            "runtime": node.runtime,
            "roles": role_list,
            "capability_tier": model_tier(model or self.model),
            "encrypted_tasks": bool(node.enc_pubkey),
            "staked": stake_requirements(state, wallet_address, node_id)["staked"],
            "hub": self.hub_id,
        }

    def heartbeat(self, node_id: str) -> dict[str, Any]:
        with self._lock:
            node = self._compute.get(node_id)
            if node is None:
                raise ValueError("Not registered — call /api/compute/register first")
            node.touch()
            node.heartbeat_count += 1
        return {"ok": True}

    def unregister_compute(self, node_id: str) -> dict[str, Any]:
        """Immediately remove a compute node from the live mesh (Stop Earn)."""
        node_id = node_id.strip()
        if not node_id:
            raise ValueError("node_id required")
        with self._lock:
            removed = self._compute.pop(node_id, None)
            self._wallet_by_worker.pop(node_id, None)
        if removed is None:
            self._log("leave", f"Compute leave (already gone): {node_id}", node_id=node_id)
            return {"ok": True, "node_id": node_id, "was_online": False}
        self._log("leave", f"Compute left network: {node_id}", node_id=node_id)
        self._flow("leave", from_id=f"compute:{node_id}", to_id="hub", detail="leave")
        return {
            "ok": True,
            "node_id": node_id,
            "was_online": True,
            "wallet_address": removed.wallet_address,
        }

    def _node_eligible_for_task(
        self,
        node: ComputeRegistration,
        task: ActiveTask,
        online_same_runtime: list[ComputeRegistration],
    ) -> bool:
        """Prefer nodes with model tier ≥ task tier; site-01 always eligible fallback."""
        need = tier_rank(task.tier or "tiny")
        node_rank = tier_rank(model_tier(node.model))
        if node_rank >= need:
            return True
        better = [
            n
            for n in online_same_runtime
            if tier_rank(model_tier(n.model)) >= need
        ]
        if not better:
            return True
        if node.node_id == self.site_node_id:
            return True
        return False

    def _require_enc_for_blind(self, node: ComputeRegistration) -> None:
        """HUB_BLIND=1: all runtimes (ollama + browser) must register enc_pubkey."""
        if not hub_blind():
            return
        if not node.enc_pubkey:
            raise ValueError(
                "HUB_BLIND requires enc_pubkey — regenerate compute keys and re-register"
            )

    def list_open_offers(self, node_id: str) -> list[dict[str, Any]]:
        """Open TASK_OFFERs claimable by this node (mailbox + hub-ready tasks)."""
        with self._lock:
            node = self._compute.get(node_id)
            if node is None:
                raise ValueError("Not registered")
            state = get_chain().current_state()
            if not has_minimum_stake(state, node.wallet_address, node_id):
                raise ValueError(f"Insufficient stake — lock at least {MIN_STAKE} MLC")
            node.touch()
            self._require_enc_for_blind(node)
            node_runtime = normalize_runtime(node.runtime)
            online_same = [
                n
                for n in self._compute.values()
                if n.is_online() and normalize_runtime(n.runtime) == node_runtime
            ]
            ready_ids: list[str] = []
            for task in self._tasks.values():
                if task.done or not task.ready_for_compute:
                    continue
                if normalize_runtime(task.runtime) != node_runtime:
                    continue
                if node_id in task.assigned:
                    continue
                if not self._node_eligible_for_task(node, task, online_same):
                    continue
                ready_ids.append(task.task_id)

        mesh_offers = []
        try:
            mesh_offers = get_mesh().open_offers(runtime=node_runtime)
        except Exception:
            mesh_offers = []

        by_id: dict[str, dict[str, Any]] = {}
        for row in mesh_offers:
            tid = str(row.get("task_id", "")).strip()
            if tid and tid in ready_ids:
                by_id[tid] = {
                    "task_id": tid,
                    "prompt_hash": row.get("prompt_hash", ""),
                    "runtime": row.get("runtime", node_runtime),
                    "model": row.get("model") or row.get("preferred_model") or "",
                    "tier": row.get("tier", ""),
                    "preferred_model": row.get("preferred_model", ""),
                    "tokens_est": row.get("tokens_est", 0),
                    "complexity": row.get("complexity", 0),
                    "created_at": row.get("created_at"),
                }
        with self._lock:
            for tid in ready_ids:
                if tid in by_id:
                    continue
                task = self._tasks.get(tid)
                if not task:
                    continue
                by_id[tid] = {
                    "task_id": tid,
                    "prompt_hash": task.prompt_hash,
                    "runtime": normalize_runtime(task.runtime),
                    "model": task.preferred_model,
                    "tier": task.tier,
                    "preferred_model": task.preferred_model,
                    "tokens_est": task.tokens_est,
                    "complexity": task.complexity,
                    "created_at": task.created,
                }
        return sorted(by_id.values(), key=lambda r: float(r.get("created_at") or 0))

    def claim_task(self, node_id: str, task_id: str) -> dict[str, Any]:
        """Mesh-first claim of a specific open offer."""
        task_id = task_id.strip()
        if not task_id:
            raise ValueError("task_id required")
        payload = self._assign_task(node_id, task_id)
        if payload is None:
            raise ValueError("Offer unavailable or already claimed")
        return payload

    def _assign_task(self, node_id: str, task_id: str | None = None) -> dict[str, Any] | None:
        """Assign a ready task to node_id. If task_id is None, pick the first eligible."""
        from proof_hash import sha256_text
        from task_crypto import encrypt_task

        with self._lock:
            node = self._compute.get(node_id)
            if node is None:
                raise ValueError("Not registered")
            state = get_chain().current_state()
            if not has_minimum_stake(state, node.wallet_address, node_id):
                raise ValueError(f"Insufficient stake — lock at least {MIN_STAKE} MLC")
            node.touch()
            self._require_enc_for_blind(node)

            node_runtime = normalize_runtime(node.runtime)
            online_same = [
                n
                for n in self._compute.values()
                if n.is_online() and normalize_runtime(n.runtime) == node_runtime
            ]
            claimed: dict[str, Any] | None = None
            candidates = (
                [self._tasks[task_id]]
                if task_id and task_id in self._tasks
                else list(self._tasks.values())
            )
            for task in candidates:
                if task_id and task.task_id != task_id:
                    continue
                if task.done or not task.ready_for_compute:
                    continue
                if normalize_runtime(task.runtime) != node_runtime:
                    continue
                if node_id in task.assigned:
                    continue
                if not self._node_eligible_for_task(node, task, online_same):
                    continue

                plaintext = task.prompt_for_assign()
                if not plaintext and not (node.enc_pubkey and node_id in task.enc_by_node):
                    continue

                task.assigned.add(node_id)
                node.status = "inferring"
                node.last_action = f"Task {task.task_id}"
                if not task.prompt_hash and plaintext:
                    task.prompt_hash = sha256_text(plaintext)
                prefer = task.preferred_model or self._resolved_model or self.model
                route = {
                    "task_id": task.task_id,
                    "tokens_est": task.tokens_est,
                    "complexity": task.complexity,
                    "tier": task.tier,
                    "preferred_model": prefer,
                    "assigned": node_id,
                    "model": node.model,
                    "ts": time.time(),
                    "mode": task.mode,
                    "internet": task.internet,
                    "web_context": task.web_context,
                    "num_predict": task.num_predict,
                }
                self.last_route = route
                self._route_history.append(route)
                self._route_history[:] = self._route_history[-40:]
                self._log(
                    "route",
                    f"route task={task.task_id} tier={task.tier} tokens≈{task.tokens_est} "
                    f"→ prefer={prefer} assign={node_id}",
                    node_id=node_id,
                    task_id=task.task_id,
                )
                payload: dict[str, Any] = {
                    "task_id": task.task_id,
                    "prompt_hash": task.prompt_hash,
                    "runtime": normalize_runtime(task.runtime),
                    "preferred_model": prefer,
                    "tier": task.tier,
                    "tokens_est": task.tokens_est,
                    "complexity": task.complexity,
                    "anonymous": True,
                    "via_relay": True,
                    "hub_blind": hub_blind(),
                    "mode": task.mode or "verified",
                }
                if task.num_predict is not None:
                    payload["num_predict"] = task.num_predict
                    payload["max_tokens"] = task.num_predict
                # Plaintext only when hub-blind is off, or legacy browser without keys yet.
                allow_plaintext = not hub_blind() or (
                    normalize_runtime(node.runtime) == "browser" and not node.enc_pubkey
                )
                if node.enc_pubkey and plaintext:
                    enc = encrypt_task(plaintext, node.enc_pubkey)
                    hub_priv = enc.pop("_hub_ephem_priv", "")
                    task.enc_by_node[node_id] = {**enc, "_hub_ephem_priv": hub_priv}
                    payload.update(enc)
                    # Wipe plaintext from task after encrypt (keep hold only for further assigns).
                    if hub_blind():
                        if not task._prompt_hold:
                            task._prompt_hold = plaintext
                        task.prompt = ""
                elif allow_plaintext and plaintext:
                    payload["prompt"] = plaintext
                elif node.enc_pubkey and node_id in task.enc_by_node:
                    # Re-issue stored ciphertext for this node
                    stored = {k: v for k, v in task.enc_by_node[node_id].items() if k != "_hub_ephem_priv"}
                    payload.update(stored)
                else:
                    task.assigned.discard(node_id)
                    continue
                claimed = {
                    "payload": payload,
                    "task_id": task.task_id,
                    "runtime": normalize_runtime(task.runtime),
                    "assigned": sorted(task.assigned),
                    "tier": task.tier,
                    "preferred_model": prefer,
                    "tokens_est": task.tokens_est,
                }
                break
        if claimed is None:
            return None

        out_task_id = str(claimed["task_id"])
        runtime = str(claimed["runtime"])
        self.last_task_assignment = {
            "task_id": out_task_id,
            "assigned_node_ids": claimed["assigned"],
            "node_id": node_id,
            "runtime": runtime,
            "tier": claimed.get("tier"),
            "preferred_model": claimed.get("preferred_model"),
            "tokens_est": claimed.get("tokens_est"),
            "ts": time.time(),
        }
        self._log(
            "assign",
            f"task assign task={out_task_id} → node={node_id} runtime={runtime} "
            f"tier={claimed.get('tier')} prefer={claimed.get('preferred_model')}",
            node_id=node_id,
            task_id=out_task_id,
        )
        self._flow(
            "task_assign",
            from_id="hub",
            to_id=f"compute:{node_id}",
            task_id=out_task_id,
            detail=f"runtime={runtime} tier={claimed.get('tier')}",
        )
        try:
            get_mesh().gossip_task_claim(task_id=out_task_id, node_id=node_id, runtime=runtime)
        except Exception:
            pass
        return claimed["payload"]

    def poll_task(self, node_id: str) -> dict[str, Any] | None:
        """Fallback claim path — prefer list_open_offers → claim_task when possible."""
        return self._assign_task(node_id, task_id=None)

    def submit_result(
        self,
        *,
        task_id: str,
        node_id: str,
        response: str,
        inference_ms: float,
        model: str,
        attestation: dict[str, Any] | None = None,
        response_encrypted: bool = False,
        response_ciphertext: str = "",
        response_nonce: str = "",
    ) -> dict[str, Any]:
        from attestation import verify_attestation
        from proof_hash import sha256_text
        from task_crypto import decrypt_response_payload

        plaintext = response
        with self._lock:
            task = self._tasks.get(task_id)
            node = self._compute.get(node_id)
            enc_meta = (task.enc_by_node.get(node_id) if task else {}) or {}
            if response_encrypted and enc_meta.get("_hub_ephem_priv") and node and node.enc_pubkey:
                plaintext = decrypt_response_payload(
                    {
                        "response_encrypted": True,
                        "response_ciphertext": response_ciphertext,
                        "response_nonce": response_nonce,
                    },
                    hub_ephem_priv_hex=str(enc_meta["_hub_ephem_priv"]),
                    compute_enc_pubkey_hex=node.enc_pubkey,
                )

        response_hash = ""
        if attestation and attestation.get("output_hash"):
            response_hash = str(attestation["output_hash"])
        elif plaintext:
            response_hash = sha256_text(plaintext)
        elif response:
            response_hash = sha256_text(response)

        if attestation:
            ok, reason = verify_attestation(attestation)
            if not ok:
                raise ValueError(f"Invalid model attestation: {reason}")
            if plaintext and attestation.get("output_hash") != sha256_text(plaintext):
                raise ValueError("Attestation output hash mismatch")
            if attestation.get("model") != model:
                raise ValueError("Attestation model mismatch")

        # Hub-blind: keep hashes + encrypted blobs; drop peer plaintexts until winner finalize.
        store_plaintext = plaintext
        if hub_blind() and (response_encrypted or plaintext):
            # Hold plaintext only in response_blob for winner decrypt; not in TaskResult.
            store_plaintext = ""

        result = TaskResult(
            task_id=task_id,
            worker_id=node_id,
            prompt="",
            response=store_plaintext,
            inference_ms=inference_ms,
            model=model,
            response_hash=response_hash,
        )

        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or task.done:
                return {"ok": False, "error": "Task not found or already finalized"}

            if any(item.worker_id == node_id for item in task.results):
                return {"ok": True, "duplicate": True}

            blob: dict[str, Any] = {"response_hash": response_hash}
            if response_encrypted and response_ciphertext:
                blob.update(
                    {
                        "response_encrypted": True,
                        "response_ciphertext": response_ciphertext,
                        "response_nonce": response_nonce,
                    }
                )
            elif plaintext:
                blob["plaintext"] = plaintext
            task.response_blob_by_node[node_id] = blob
            task.results.append(result)
            node = self._compute.get(node_id)
            if node:
                node.status = "online"
                node.last_action = f"Finished in {inference_ms:.0f}ms"
                node.tasks_completed += 1
                node.touch()

            task_runtime = normalize_runtime(task.runtime)
            task_mode = str(task.mode or "verified").strip().lower()
            expected = max(
                1,
                sum(
                    1
                    for n in self._compute.values()
                    if n.is_online() and normalize_runtime(n.runtime) == task_runtime
                ),
            )
            if task.quorum_target is not None:
                need = max(1, int(task.quorum_target))
            else:
                need = min(expected, 3)
            # MESH_CONSENSUS: verified/earn settlement needs ≥2 when enough peers online.
            # Chat fast mode (quorum_target=1) stays at 1 for UX.
            if mesh_consensus() and task_mode != "fast" and expected >= 2:
                need = max(need, 2)

            result_count = len(task.results)
            hashes = [item.response_hash for item in task.results if item.response_hash]
            hash_agreement = False
            agree_hash = ""
            agree_n = 0
            if hub_blind() and len(hashes) >= 2:
                from collections import Counter

                top_hash, top_n = Counter(hashes).most_common(1)[0]
                if top_n >= 2:
                    hash_agreement = True
                    agree_hash = top_hash
                    agree_n = top_n

            ready = result_count >= need or result_count >= expected
            # Prefer finalize from hash agreement when mesh peers also gossiped TASK_RESULT.
            if hash_agreement:
                peer_attest = False
                try:
                    peer_attest = get_mesh().has_peer_task_result(
                        task_id, response_hash=agree_hash
                    ) or get_mesh().has_peer_task_result(task_id)
                except Exception:
                    peer_attest = False
                if peer_attest or (mesh_consensus() and agree_n >= 2):
                    ready = True
            if mesh_consensus() and task_mode != "fast" and expected >= 2:
                ready = ready and result_count >= 2

        self._log(
            "infer",
            f"task result task={task_id} ← node={node_id}",
            node_id=node_id,
            task_id=task_id,
        )
        self._flow(
            "task_result",
            from_id=f"compute:{node_id}",
            to_id="hub",
            task_id=task_id,
            detail=f"model={model}",
        )
        try:
            get_mesh().gossip_task_result(
                task_id=task_id,
                node_id=node_id,
                response_hash=response_hash,
                model=model,
            )
        except Exception:
            pass

        if ready:
            self._finalize_task(task_id)
            with self._lock:
                self.running_tasks.discard(task_id)
                self.running_task = next(iter(self.running_tasks), None)
        return {"ok": True}

    def _local_infer(
        self,
        node_id: str,
        task_id: str,
        prompt: str,
        *,
        preferred_model: str | None = None,
    ) -> tuple[TaskResult, dict[str, Any]]:
        want = preferred_model or self._resolved_model or self.model
        client = OllamaClient(model=want)
        num_predict: int | None = None
        try:
            if client.is_available():
                available = client.list_models()
                with self._lock:
                    task = self._tasks.get(task_id)
                    tier = task.tier if task else model_tier(want)
                    num_predict = task.num_predict if task else None
                resolved = resolve_model_for_tier(
                    available, tier, fallback=want
                )
                if preferred_model and preferred_model in available:
                    resolved = preferred_model
                elif preferred_model:
                    # Prefer exact preferred if prefix-match installed
                    for inst in available:
                        if inst == preferred_model or inst.startswith(preferred_model.split(":")[0]):
                            if tier_rank(model_tier(inst)) >= tier_rank(tier) or inst == preferred_model:
                                resolved = inst
                                break
                client.model = resolved
            else:
                client.model = want
                with self._lock:
                    task = self._tasks.get(task_id)
                    num_predict = task.num_predict if task else None
        except OllamaError:
            client.model = want
            with self._lock:
                task = self._tasks.get(task_id)
                num_predict = task.num_predict if task else None

        started = time.perf_counter()
        output = client.generate(
            prompt, system=NOETI_SYSTEM_PREAMBLE, num_predict=num_predict
        )
        elapsed = (time.perf_counter() - started) * 1000
        counts: dict[str, Any] = {}
        if output.prompt_eval_count is not None:
            counts["prompt_eval_count"] = output.prompt_eval_count
        if output.eval_count is not None:
            counts["eval_count"] = output.eval_count
        result = TaskResult(
            task_id=task_id,
            worker_id=node_id,
            prompt=prompt,
            response=output.response,
            inference_ms=elapsed,
            model=output.model,
        )
        return result, counts

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        """Lookup in-flight or finished task by id (mesh-friendly API). Never returns plaintext prompt."""
        self._expire_stale_tasks()
        with self._lock:
            for summary in reversed(self._stats):
                if summary.task_id == task_id:
                    d = summary.to_dict()
                    d["status"] = "done"
                    d["prompt"] = ""
                    d["prompt_hash"] = getattr(summary, "prompt_hash", "") or ""
                    if self.last_route and self.last_route.get("task_id") == task_id:
                        d["last_route"] = self.last_route
                    # Strip peer response plaintexts from public poll (keep consensus + hashes).
                    for row in d.get("results") or []:
                        if isinstance(row, dict):
                            row["prompt"] = ""
                            if hub_blind() and not row.get("matched_consensus"):
                                row["response"] = ""
                    return d
            active = self._tasks.get(task_id)
            if active is not None:
                return {
                    "task_id": task_id,
                    "status": "done" if active.done else "running",
                    "prompt": "",
                    "prompt_hash": active.prompt_hash,
                    "workers_responded": len(active.results),
                    "consensus_response": None,
                    "created": active.created,
                    "complexity": active.complexity,
                    "tokens_est": active.tokens_est,
                    "tier": active.tier,
                    "preferred_model": active.preferred_model,
                    "runtime": active.runtime,
                    "assigned": sorted(active.assigned),
                    "hub_blind": hub_blind(),
                    "mode": active.mode,
                    "internet": active.internet,
                    "num_predict": active.num_predict,
                    "last_route": self.last_route
                    if self.last_route and self.last_route.get("task_id") == task_id
                    else None,
                }
        return None

    def start_infer(
        self,
        prompt: str,
        *,
        mode: str = "fast",
        internet: bool = False,
        max_tokens: Any = None,
    ) -> str:
        """Create a task and return task_id immediately (supports concurrent asks)."""
        from proof_hash import sha256_text

        prompt = prompt.strip()
        if not prompt:
            raise ValueError("Prompt required")

        mode_norm = str(mode or "fast").strip().lower()
        if mode_norm not in {"fast", "verified"}:
            mode_norm = "fast"
        want_internet = bool(internet)
        num_predict = clamp_max_tokens(max_tokens)
        quorum_target = 1 if mode_norm == "fast" else None

        boot = self.bootstrap()
        if not boot.get("ok"):
            raise RuntimeError(boot.get("error", "Network unavailable"))

        # Ensure site compute can claim if no external nodes
        if self._ollama.is_available():
            try:
                self.ensure_site_compute()
            except Exception as exc:
                self._log("error", f"ensure_site_compute: {exc}")

        # Authoritative clock for every worker (even when internet is off).
        time_block = build_time_context()
        web_ok = False
        web_block = ""
        if want_internet:
            # Best-effort: same web facts for all workers; captcha pages are failures.
            ctx = fetch_web_context(prompt, timeout=7.0)
            if ctx:
                web_block = f"[web context]\n{ctx}"
                web_ok = True
            else:
                web_block = "[web context]\n(No live results retrieved.)"
                web_ok = False
                self._log(
                    "task",
                    "internet requested but web context fetch failed — continuing with empty web notice",
                )

        parts = [time_block]
        if web_block:
            parts.append(web_block)
        parts.append(prompt)
        prompt = "\n\n".join(parts)

        scored = score_prompt(prompt)
        preferred = scored["preferred_models"][0] if scored.get("preferred_models") else self.model
        try:
            if self._ollama.is_available():
                preferred = resolve_model_for_tier(
                    self._ollama.list_models(),
                    scored["tier"],
                    fallback=self._resolved_model or self.model,
                )
        except OllamaError:
            preferred = self._resolved_model or self.model

        with self._lock:
            active = len(self.running_tasks)
            if active >= self.max_active_tasks:
                raise RuntimeError(f"Too many active tasks ({active}/{self.max_active_tasks})")
            task_id = uuid.uuid4().hex[:12]
            self.running_tasks.add(task_id)
            self.running_task = task_id
            self.last_error = None
            ollama_n = sum(
                1
                for n in self._compute.values()
                if n.is_online() and normalize_runtime(n.runtime) == "ollama"
            )
            browser_n = sum(
                1
                for n in self._compute.values()
                if n.is_online() and normalize_runtime(n.runtime) == "browser"
            )
            task_runtime = "ollama" if ollama_n > 0 else ("browser" if browser_n > 0 else "ollama")
            prompt_hash = sha256_text(prompt)
            created = time.time()
            self._tasks[task_id] = ActiveTask(
                task_id=task_id,
                prompt=prompt,
                created=created,
                prompt_hash=prompt_hash,
                _prompt_hold=prompt if hub_blind() else "",
                runtime=task_runtime,
                complexity=int(scored["complexity"]),
                tokens_est=int(scored["tokens_est"]),
                tier=str(scored["tier"]),
                preferred_model=preferred,
                score_reasons=list(scored.get("reasons") or []),
                mode=mode_norm,
                internet=want_internet,
                web_context=web_ok,
                num_predict=num_predict,
                quorum_target=quorum_target,
            )
            self.last_route = {
                "task_id": task_id,
                "tokens_est": scored["tokens_est"],
                "complexity": scored["complexity"],
                "tier": scored["tier"],
                "preferred_model": preferred,
                "assigned": None,
                "model": preferred,
                "ts": created,
                "mode": mode_norm,
                "internet": want_internet,
                "web_context": web_ok,
                "num_predict": num_predict,
            }
            self._route_history.append(dict(self.last_route))
            self._route_history[:] = self._route_history[-40:]

        self._log(
            "task",
            f"task create task={task_id} runtime={task_runtime} tier={scored['tier']} "
            f"tokens≈{scored['tokens_est']} prefer={preferred} mode={mode_norm} "
            f"internet={want_internet}"
            + (f" web={'ok' if web_ok else 'fail'}" if want_internet else ""),
            task_id=task_id,
        )
        self._flow(
            "task_create",
            from_id="user/chat",
            to_id="hub",
            task_id=task_id,
            detail=f"runtime={task_runtime} tier={scored['tier']}",
        )
        try:
            get_mesh().gossip_task_offer(
                task_id=task_id,
                prompt_hash=prompt_hash,
                runtime=task_runtime,
                model=preferred,
                origin=self.hub_id,
                created_at=created,
                tier=str(scored["tier"]),
                preferred_model=preferred,
                tokens_est=int(scored["tokens_est"]),
                complexity=int(scored["complexity"]),
            )
        except Exception:
            pass
        return task_id

    def dispatch_infer(self, task_id: str) -> TaskSummary | None:
        """Run dispatch / site-01 path for an already-created task."""
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise ValueError("Unknown task_id")
            prompt = task.prompt_for_assign()
            preferred = task.preferred_model

        if self._ollama.is_available():
            try:
                self.ensure_site_compute()
            except Exception:
                pass

        online = self.online_compute()
        self._auto_relay_if_needed(task_id)
        relay_count = len(self.online_relays())
        self._log(
            "task",
            f"user/chat → hub → relay/compute task={task_id} ({relay_count} relay(s), {len(online)} compute)",
            task_id=task_id,
        )
        self._flow(
            "dispatch",
            from_id="hub",
            to_id="relay" if relay_count else "compute:pool",
            task_id=task_id,
            detail=f"relays={relay_count} compute={len(online)}",
        )

        try:
            if online:
                # Site worker (or external compute) claims via poll_task — real wallet rewards.
                return TaskSummary(
                    task_id=task_id,
                    prompt=prompt,
                    consensus_response="",
                    results=[],
                    workers_responded=0,
                    workers_matched=0,
                )

            # Last resort: internal claim as site-01 with real wallet (no synthetic local-01..03)
            if not self._ollama.is_available():
                raise RuntimeError("No compute online and Ollama unavailable")

            site = self.ensure_site_compute()
            node_id = str(site.get("node_id") or self.site_node_id)
            self._auto_relay_if_needed(task_id)
            result, counts = self._local_infer(
                node_id, task_id, prompt, preferred_model=preferred or None
            )
            if counts and self.last_route and self.last_route.get("task_id") == task_id:
                self.last_route = {**self.last_route, "assigned": node_id, **counts}
            with self._lock:
                task = self._tasks.get(task_id)
                if task:
                    task.assigned.add(node_id)
                    task.results.append(result)
            self._finalize_task(task_id)
            with self._lock:
                for summary in reversed(self._stats):
                    if summary.task_id == task_id:
                        return summary
            return TaskSummary(
                task_id=task_id,
                prompt=prompt,
                consensus_response=result.response,
                results=[result],
                workers_responded=1,
                workers_matched=1,
            )
        except Exception as exc:
            self.last_error = str(exc)
            self._log("error", self.last_error, task_id=task_id)
            with self._lock:
                self.running_tasks.discard(task_id)
                self.running_task = next(iter(self.running_tasks), None)
            raise

    def infer(
        self,
        prompt: str,
        *,
        mode: str = "fast",
        internet: bool = False,
        max_tokens: Any = None,
    ) -> TaskSummary:
        """Back-compat: start + dispatch in one call."""
        task_id = self.start_infer(
            prompt, mode=mode, internet=internet, max_tokens=max_tokens
        )
        summary = self.dispatch_infer(task_id)
        if summary is not None:
            return summary
        return TaskSummary(
            task_id=task_id,
            prompt=prompt.strip(),
            consensus_response="",
            results=[],
            workers_responded=0,
            workers_matched=0,
        )

    def _resolve_result_plaintext(self, task: ActiveTask, node_id: str) -> str:
        """Decrypt or recover plaintext for a single worker result (winner path)."""
        from task_crypto import decrypt_response_payload

        blob = task.response_blob_by_node.get(node_id) or {}
        if blob.get("plaintext"):
            return str(blob["plaintext"])
        for item in task.results:
            if item.worker_id == node_id and item.response:
                return item.response
        if blob.get("response_encrypted") and blob.get("response_ciphertext"):
            enc_meta = task.enc_by_node.get(node_id) or {}
            node = self._compute.get(node_id)
            hub_priv = str(enc_meta.get("_hub_ephem_priv") or "")
            if hub_priv and node and node.enc_pubkey:
                try:
                    return decrypt_response_payload(
                        {
                            "response_encrypted": True,
                            "response_ciphertext": blob["response_ciphertext"],
                            "response_nonce": blob.get("response_nonce", ""),
                        },
                        hub_ephem_priv_hex=hub_priv,
                        compute_enc_pubkey_hex=node.enc_pubkey,
                    )
                except Exception:
                    return ""
        return ""

    def _finalize_task(self, task_id: str) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or task.done or not task.results:
                return
            task.done = True
            prompt = task.prompt_for_assign()
            prompt_hash = task.prompt_hash
            results = list(task.results)
            blobs = dict(task.response_blob_by_node)
            enc_by_node = dict(task.enc_by_node)
            # Clear prompt holds after finalize decision material is copied.
            task.prompt = ""
            task._prompt_hold = ""

        self._finalize_results(
            task_id,
            prompt,
            results,
            prompt_hash=prompt_hash,
            blobs=blobs,
            enc_by_node=enc_by_node,
        )

    def _finalize_results(
        self,
        task_id: str,
        prompt: str,
        results: list[TaskResult],
        *,
        prompt_hash: str = "",
        blobs: dict[str, dict[str, Any]] | None = None,
        enc_by_node: dict[str, dict[str, Any]] | None = None,
    ) -> TaskSummary:
        from proof_hash import sha256_text
        from reward import pick_consensus_hash

        blobs = blobs or {}
        enc_by_node = enc_by_node or {}

        for item in results:
            item.prompt = ""  # never persist plaintext prompt on results
            item.task_id = task_id
            if not item.response_hash:
                if item.response:
                    item.response_hash = sha256_text(item.response)
                elif blobs.get(item.worker_id, {}).get("response_hash"):
                    item.response_hash = str(blobs[item.worker_id]["response_hash"])

        use_hash = hub_blind() and any(item.response_hash for item in results)
        if use_hash:
            winner_hash = pick_consensus_hash(results)
            consensus = ""
            winner_id = ""
            for item in results:
                if item.response_hash == winner_hash:
                    winner_id = item.worker_id
                    # Decrypt only the winner for chat consensus_response.
                    with self._lock:
                        task = self._tasks.get(task_id)
                        if task is not None:
                            consensus = self._resolve_result_plaintext(task, item.worker_id)
                        else:
                            # Task already marked done — use local blob copy.
                            blob = blobs.get(item.worker_id) or {}
                            consensus = str(blob.get("plaintext") or "")
                            if not consensus and blob.get("response_encrypted"):
                                from task_crypto import decrypt_response_payload

                                meta = enc_by_node.get(item.worker_id) or {}
                                node = self._compute.get(item.worker_id)
                                hub_priv = str(meta.get("_hub_ephem_priv") or "")
                                if hub_priv and node and node.enc_pubkey:
                                    try:
                                        consensus = decrypt_response_payload(
                                            {
                                                "response_encrypted": True,
                                                "response_ciphertext": blob.get(
                                                    "response_ciphertext", ""
                                                ),
                                                "response_nonce": blob.get("response_nonce", ""),
                                            },
                                            hub_ephem_priv_hex=hub_priv,
                                            compute_enc_pubkey_hex=node.enc_pubkey,
                                        )
                                    except Exception:
                                        consensus = ""
                    if consensus:
                        item.response = consensus
                    break
            for item in results:
                item.matched_consensus = bool(
                    winner_hash and item.response_hash == winner_hash
                )
                item.reward = 0.0
            matched = [item for item in results if item.matched_consensus]
            if matched:
                scores = [1.0 / max(item.inference_ms, 1.0) for item in matched]
                total = sum(scores) or 1.0
                for item in matched:
                    share = (1.0 / max(item.inference_ms, 1.0)) / total
                    item.reward = round(10.0 * share, 4)
            # Drop non-winner plaintexts
            for item in results:
                if not item.matched_consensus:
                    item.response = ""
            winner = winner_id or (results[0].worker_id if results else "none")
        else:
            # Recover plaintext into results for classic majority when available.
            for item in results:
                if not item.response:
                    blob = blobs.get(item.worker_id) or {}
                    if blob.get("plaintext"):
                        item.response = str(blob["plaintext"])
            consensus = pick_consensus(
                [item.response for item in results if item.response],
                normalize=normalize_response,
            )
            results = calculate_rewards(
                results,
                consensus,
                base_reward=10.0,
                normalize=normalize_response,
            )
            winner = next(
                (item.worker_id for item in results if item.matched_consensus),
                results[0].worker_id if results else "none",
            )

        self._log(
            "consensus",
            f"task finalize task={task_id} winner={winner}",
            task_id=task_id,
        )
        self._flow(
            "finalize",
            from_id="hub",
            to_id="chain",
            task_id=task_id,
            detail=f"winner={winner}",
        )

        summary = TaskSummary(
            task_id=task_id,
            prompt="",  # never store plaintext prompt in stats
            consensus_response=consensus,
            results=results,
            workers_responded=len(results),
            workers_matched=sum(1 for item in results if item.matched_consensus),
        )
        # Attach prompt_hash for clients (not on dataclass by default).
        setattr(summary, "prompt_hash", prompt_hash or (sha256_text(prompt) if prompt else ""))
        self._stats.append(summary)
        with self._lock:
            self.running_tasks.discard(task_id)
            self.running_task = next(iter(self.running_tasks), None)
            task = self._tasks.get(task_id)
            if task is not None:
                task.response_blob_by_node.clear()

        state = get_chain().current_state()
        wallet_map = dict(self._wallet_by_worker)
        for item in results:
            wallet_map.setdefault(item.worker_id, item.worker_id)
        slash_transactions = slash_outliers(
            state=state,
            results=results,
            wallet_by_worker=wallet_map,
            task_id=task_id,
        )
        if slash_transactions:
            self._log(
                "slash",
                f"Slashing {len(slash_transactions)} outlier(s) — Sybil resistance",
                task_id=task_id,
            )

        block = finalize_on_chain(
            summary,
            wallet_by_worker=wallet_map,
            slash_transactions=slash_transactions,
        )
        self._log(
            "block",
            f"Block #{block.index} committed — {block.proof.get('mlc_distributed', 0)} MLC on-chain",
            task_id=task_id,
        )
        try:
            from proof_hash import sha256_text as _sha

            consensus_hash = ""
            for item in results:
                if item.matched_consensus and item.response_hash:
                    consensus_hash = item.response_hash
                    break
            if not consensus_hash and consensus:
                consensus_hash = _sha(consensus)
            get_mesh().gossip_task_finalized(
                task_id=task_id,
                winner=winner,
                consensus_hash=consensus_hash,
                workers_responded=len(results),
                workers_matched=sum(1 for item in results if item.matched_consensus),
            )
        except Exception:
            pass
        return summary

    def submit_signed_transaction(self, tx: dict[str, Any]) -> dict[str, Any]:
        state = get_chain().current_state()
        error = validate_transaction(tx, state)
        if error:
            raise ValueError(error)
        ok, message = add_to_mempool(tx)
        if not ok:
            raise ValueError(message)
        self._log("tx", f"Mempool: {tx.get('type')} {tx.get('amount')} MLC")
        return {"ok": True, "message": message, "mempool": True}

    def merge_remote_chain(self, blocks: list[dict[str, Any]]) -> dict[str, Any]:
        result = get_chain().merge_chain(blocks)
        action = result.get("action")
        if action in {"merged", "replaced"}:
            self._log("sync", f"P2P chain {action} — length {result.get('length')}")
        elif result.get("rejected"):
            self._log("sync", "Rejected invalid chain from peer")
        return result

    def cosign_block(self, block: dict[str, Any]) -> dict[str, Any]:
        from consensus import make_cosignature, verify_cosignature

        local = get_chain()
        if block.get("index") != len(local.chain):
            raise ValueError("Block index does not extend local chain")
        if block.get("previous_hash") != local.last_block.hash:
            raise ValueError("Block previous_hash mismatch")
        extended = [item.to_dict() for item in local.chain] + [block]
        probe = get_chain().__class__()
        probe.chain = probe._blocks_from_payload(extended)
        # The candidate tip has only the producer's signature; its cosignatures
        # (including ours) are assembled after this call, so don't require quorum yet.
        if not probe.is_valid_structure(require_tip_quorum=False) or not probe.is_valid_state():
            raise ValueError("Invalid block — rejected")
        proof = block.get("proof") or {}
        cosign = make_cosignature(proof, str(block.get("hash", "")))
        if not verify_cosignature(cosign, proof, str(block.get("hash", ""))):
            raise ValueError("Failed to create cosignature")
        self._log("consensus", f"Cosigned block #{block.get('index')}")
        return {"ok": True, "cosignature": cosign}

    def grant_faucet(self, address: str, amount: float) -> dict[str, Any]:
        from treasury import faucet_allowed, faucet_mode, grant_onboarding_credit

        if faucet_mode() in {"limited", "rate_limited"}:
            return grant_onboarding_credit(address, amount)
        if not faucet_allowed():
            raise ValueError("transfer MLC or earn — faucet is off")
        from chain_state import credit_tx

        block = get_chain().add_state_block(
            [
                credit_tx(
                    to_address=address,
                    amount=amount,
                    reason="Dev faucet credit",
                )
            ],
            data=f"Faucet — {amount} MLC to {address[:16]}…",
        )
        self._log("faucet", f"Credited {amount} MLC to {address[:16]}…")
        return {"ok": True, "block_index": block.index, "amount": amount, "address": address}

    def _expire_stale_tasks(self) -> None:
        now = time.time()
        with self._lock:
            for task_id, task in list(self._tasks.items()):
                if task.done:
                    continue
                if now - task.created > TASK_TIMEOUT:
                    task.done = True
                    self.running_tasks.discard(task_id)
                    self.running_task = next(iter(self.running_tasks), None)
                    self.last_error = "Task timed out — no compute response"
                    self._log("error", self.last_error, task_id=task_id)

    def _refresh_coordinator_roles(self) -> list[str]:
        """Site-01 always coordinator; others by stake/uptime or top-K ollama stake."""
        state = get_chain().current_state()
        online = self.online_compute()
        site_id = self.site_node_id
        coordinator_ids: set[str] = {site_id}

        ollama_online = [n for n in online if normalize_runtime(n.runtime) == "ollama"]
        scored: list[tuple[float, str]] = []
        for node in ollama_online:
            bal = get_balance(state, node.wallet_address) if node.wallet_address else {"staked": 0.0}
            staked = float(bal.get("staked", 0.0))
            eligible = node.is_online() and staked >= MIN_STAKE and (
                node.coordinator_explicit
                or node.heartbeat_count >= COORDINATOR_HEARTBEAT_N
                or node.node_id == site_id
            )
            if eligible:
                coordinator_ids.add(node.node_id)
            scored.append((staked, node.node_id))

        scored.sort(reverse=True)
        k = min(COORDINATOR_TOP_K, len(ollama_online))
        for _, nid in scored[:k]:
            coordinator_ids.add(nid)

        coords = [site_id] + sorted(nid for nid in coordinator_ids if nid != site_id)

        with self._lock:
            for node in self._compute.values():
                if node.node_id in coordinator_ids:
                    node.roles = ["coordinator", "compute"]
                    node.role = "coordinator"
                else:
                    node.roles = ["compute"]
                    node.role = "compute"

        return coords

    def site_compute_snapshot(self) -> dict[str, Any]:
        node_id = self.site_node_id
        with self._lock:
            node = self._compute.get(node_id)
        wallet = self._site_wallet.address if self._site_wallet else (node.wallet_address if node else "")
        balances = {row["address"]: row for row in get_balances()}
        row = balances.get(wallet or "", {})
        earned = float(row.get("balance", 0.0)) + float(row.get("staked", 0.0))
        model = (node.model if node else None) or self._resolved_model
        return {
            "node_id": node_id,
            "online": bool(node and node.is_online()),
            "model": model,
            "wallet": wallet,
            "wallet_short": (wallet[:10] + "…" + wallet[-6:]) if wallet and len(wallet) > 20 else wallet,
            "earned_hint": round(earned, 4),
            "mlc_balance": row.get("balance", 0.0),
            "mlc_staked": row.get("staked", 0.0),
            "tasks_completed": node.tasks_completed if node else 0,
            "roles": (node.roles if node else ["coordinator", "compute"]),
            "capability_tier": model_tier(model),
            "role": "coordinator+compute",
            "ollama": self._ollama.is_available(),
            "runtime": "ollama",
        }

    def snapshot(self) -> dict[str, Any]:
        self._expire_stale_tasks()
        coordinators = self._refresh_coordinator_roles()
        online = self.online_compute()
        online_relays = self.online_relays()
        counts = self.runtime_counts()
        nodes = [node.to_dict() for node in online]
        relays = [relay.to_dict() for relay in online_relays]
        chain = get_chain().snapshot()
        site = self.site_compute_snapshot()

        with self._events_lock:
            events = [event.to_dict() for event in self._events[-100:]]
            flows = [flow.to_dict() for flow in self._flows[-100:]]

        active_assignments: list[dict[str, Any]] = []
        with self._lock:
            route_history = list(self._route_history[-20:])
            last_route = self.last_route
            for task in self._tasks.values():
                if task.done:
                    continue
                status = "done" if task.done else (
                    "computing" if task.assigned and task.ready_for_compute
                    else "relay" if task.relay_pending
                    else "assigned" if task.assigned
                    else "pending"
                )
                active_assignments.append(
                    {
                        "task_id": task.task_id,
                        "assigned_node_ids": sorted(task.assigned),
                        "runtime": task.runtime,
                        "tier": task.tier,
                        "tokens_est": task.tokens_est,
                        "complexity": task.complexity,
                        "preferred_model": task.preferred_model,
                        "created": task.created,
                        "mode": task.mode or "verified",
                        "internet": bool(task.internet or task.web_context),
                        "status": status,
                        "relay_id": task.relay_id,
                    }
                )

        from treasury import faucet_allowed, faucet_mode
        from consensus import effective_quorum

        validators_n = len(known_validators())
        cosign_q = effective_quorum()
        faucet_on = faucet_allowed()
        faucet_m = faucet_mode()

        return {
            "mode": "network_hub",
            "role": self.role,
            "hub_id": self.hub_id,
            "observer_note": (
                "This site is an entry point + observer; validators cosign on the mesh. "
                "Site compute (coordinator+compute) earns on the same chain. "
                "As the network grows, more staked compute nodes become coordinators."
            ),
            "privacy": "user → relay → compute (compute never sees user identity)",
            "ollama_available": self._ollama.is_available(),
            "ollama_model": self._resolved_model,
            "site_compute": site,
            "coordinators": coordinators,
            "compute_count": len(online),
            "ollama_count": counts["ollama"],
            "browser_count": counts["browser"],
            "relay_count": len(online_relays),
            "node_count": len(online),
            "worker_count": len(online),
            "nodes": nodes,
            "relays": relays,
            "workers": nodes,
            "events": events,
            "flows": flows,
            "running_task": self.running_task,
            "running_tasks": sorted(self.running_tasks),
            "active_task_count": len(self.running_tasks),
            "active_assignments": active_assignments,
            "last_task_assignment": self.last_task_assignment,
            "last_route": last_route,
            "route_history": route_history,
            "dispatch_error": self.last_error,
            "last_task": self._stats[-1].to_dict() if self._stats else None,
            "task_count": len(self._stats),
            "faucet_enabled": faucet_on,
            "faucet_mode": faucet_m,
            "hub_blind": hub_blind(),
            "mesh_consensus": mesh_consensus(),
            "decentralization": {
                "validators": validators_n,
                "cosign_quorum": cosign_q,
                "mesh_consensus": mesh_consensus(),
                "hub_blind": hub_blind(),
                "faucet": faucet_m if faucet_on else "off",
            },
            "blockchain": chain,
            "mesh": get_mesh().snapshot(),
            "federation_peers": validators_n,
            "consensus_quorum": cosign_q,
            "mlc_supply_distributed": round(sum(b.get("balance", 0) for b in get_balances()), 4),
            "join_url": "/api/compute/register",
            "architecture": {
                "layers": [
                    {"name": "User", "role": "Submits prompts — never connects to compute directly"},
                    {"name": "Relay", "role": "Third-party routing layer — strips user identity"},
                    {
                        "name": "Coordinator",
                        "role": "Staked compute that also routes — grows with the network; site-01 always included",
                    },
                    {
                        "name": "Entry",
                        "role": "Website bootstrap + observer — not the sole network brain",
                    },
                    {"name": "Compute", "role": "Runs anonymous inference tasks via Ollama / browser"},
                    {"name": "Blockchain", "role": "Proof-of-Inference settlement"},
                    {"name": "MLC", "role": "Rewards for verified compute"},
                ],
                "consensus": "Hash-majority + mesh attest; blocks need federation cosign",
                "proof_type": "proof_of_inference",
                "token": "MLC",
            },
        }



_hub = NetworkHub()


def get_hub() -> NetworkHub:
    return _hub
