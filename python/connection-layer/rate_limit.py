"""Persistent rate limiting — file-backed with optional Redis."""

from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict
from pathlib import Path

_lock = threading.Lock()
_memory: dict[str, list[float]] = defaultdict(list)
_STORE_PATH = Path(__file__).parent / "data" / "rate_limits.json"
_redis = None
_redis_checked = False


def _load_store() -> dict[str, list[float]]:
    if _STORE_PATH.exists():
        try:
            raw = json.loads(_STORE_PATH.read_text())
            return {key: [float(v) for v in values] for key, values in raw.items()}
        except json.JSONDecodeError:
            return {}
    return {}


def _save_store(store: dict[str, list[float]]) -> None:
    _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    trimmed = {key: values[-500:] for key, values in store.items()}
    _STORE_PATH.write_text(json.dumps(trimmed))


def _get_redis():
    global _redis, _redis_checked
    if _redis_checked:
        return _redis
    _redis_checked = True
    url = os.environ.get("REDIS_URL", "").strip()
    if not url:
        return None
    try:
        import redis

        _redis = redis.from_url(url, decode_responses=True)
        _redis.ping()
    except Exception:
        _redis = None
    return _redis


def check_rate_limit(key: str, *, max_calls: int = 10, window_sec: float = 60.0) -> tuple[bool, str]:
    now = time.time()
    redis_client = _get_redis()
    if redis_client:
        try:
            bucket = f"noetis:rl:{key}"
            count = redis_client.incr(bucket)
            if count == 1:
                redis_client.expire(bucket, int(window_sec))
            if count > max_calls:
                ttl = redis_client.ttl(bucket)
                return False, f"Rate limit exceeded — retry in {max(ttl, 1)}s"
            return True, "ok"
        except Exception:
            pass

    with _lock:
        store = _load_store()
        hits = [t for t in store.get(key, []) if now - t < window_sec]
        if len(hits) >= max_calls:
            retry = int(window_sec - (now - hits[0]))
            return False, f"Rate limit exceeded — retry in {max(retry, 1)}s"
        hits.append(now)
        store[key] = hits
        _memory[key] = hits
        _save_store(store)
    return True, "ok"
