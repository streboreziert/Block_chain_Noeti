"""Live world-news headlines for the homepage investigative mesh."""
from __future__ import annotations

import time
import urllib.request
import xml.etree.ElementTree as ET
from threading import Lock

_FEEDS = (
    ("BBC", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("BBC", "https://feeds.bbci.co.uk/news/rss.xml"),
    ("Guardian", "https://www.theguardian.com/world/rss"),
    ("NPR", "https://feeds.npr.org/1004/rss.xml"),
    ("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"),
    ("Reuters", "https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best"),
)

_CACHE_TTL = 300  # seconds
_lock = Lock()
_cache: dict = {"ts": 0.0, "items": []}

_FALLBACK = [
    {"source": "Noeti", "title": "Claims require witnesses before they become facts"},
    {"source": "Noeti", "title": "Contradiction is a first-class object, not an error"},
    {"source": "Noeti", "title": "Negative evidence: what was searched and not found"},
    {"source": "Noeti", "title": "Independent compute — no single vendor kill switch"},
    {"source": "Noeti", "title": "Publish gates block contested claims"},
]


def _link_from_item(item) -> str:
    """Best article URL from an RSS item or Atom entry."""
    # RSS <link>text</link>
    link_el = item.find("link")
    if link_el is not None:
        href = (link_el.get("href") or (link_el.text or "")).strip()
        if href.startswith("http"):
            return href
    # RSS <guid isPermaLink="true">
    guid = item.find("guid")
    if guid is not None and (guid.get("isPermaLink") or "true").lower() != "false":
        href = (guid.text or "").strip()
        if href.startswith("http"):
            return href
    return ""


def _link_from_atom(entry, ns: dict) -> str:
    for link in entry.findall("a:link", ns):
        href = (link.get("href") or "").strip()
        rel = (link.get("rel") or "alternate").lower()
        if href.startswith("http") and rel in ("alternate", ""):
            return href
    for link in entry.findall("a:link", ns):
        href = (link.get("href") or "").strip()
        if href.startswith("http"):
            return href
    return ""


def _fetch_feed(source: str, url: str, limit: int = 8) -> list[dict]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "NoetiNewsMesh/1.0 (+https://noeticompute.com)",
            "Accept": "application/rss+xml, application/xml, text/xml, */*",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=6) as resp:
        raw = resp.read()
    root = ET.fromstring(raw)
    items: list[dict] = []
    # RSS 2.0
    for item in root.findall(".//item"):
        title_el = item.find("title")
        if title_el is None or not (title_el.text or "").strip():
            continue
        title = " ".join(title_el.text.split())
        if len(title) < 12:
            continue
        link = _link_from_item(item)
        row = {"source": source, "title": title[:160]}
        if link:
            row["url"] = link
        items.append(row)
        if len(items) >= limit:
            break
    if items:
        return items
    # Atom
    ns = {"a": "http://www.w3.org/2005/Atom"}
    for entry in root.findall(".//a:entry", ns):
        title_el = entry.find("a:title", ns)
        if title_el is None or not (title_el.text or "").strip():
            continue
        title = " ".join(title_el.text.split())
        link = _link_from_atom(entry, ns)
        row = {"source": source, "title": title[:160]}
        if link:
            row["url"] = link
        items.append(row)
        if len(items) >= limit:
            break
    return items


def get_news_items(force: bool = False) -> dict:
    now = time.time()
    with _lock:
        if not force and _cache["items"] and (now - _cache["ts"]) < _CACHE_TTL:
            return {
                "ok": True,
                "cached": True,
                "updated_at": _cache["ts"],
                "items": list(_cache["items"]),
            }

    collected: list[dict] = []
    seen: set[str] = set()
    for source, url in _FEEDS:
        try:
            for row in _fetch_feed(source, url):
                key = row["title"].lower()
                if key in seen:
                    continue
                seen.add(key)
                collected.append(row)
        except Exception:
            continue

    if len(collected) < 6:
        collected = list(_FALLBACK) + collected

    # Prefer diversity — cap total
    collected = collected[:40]
    with _lock:
        _cache["ts"] = now
        _cache["items"] = collected

    return {
        "ok": True,
        "cached": False,
        "updated_at": now,
        "items": collected,
    }
