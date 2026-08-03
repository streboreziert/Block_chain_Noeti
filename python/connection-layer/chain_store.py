"""SQLite block store — O(1) appends instead of rewriting the whole chain file."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).parent / "data" / "chain.db"

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _connection() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _conn.execute(
            "CREATE TABLE IF NOT EXISTS blocks ("
            " idx INTEGER PRIMARY KEY,"
            " hash TEXT NOT NULL,"
            " payload TEXT NOT NULL)"
        )
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.commit()
    return _conn


def load_blocks() -> list[dict[str, Any]]:
    with _lock:
        rows = _connection().execute("SELECT payload FROM blocks ORDER BY idx").fetchall()
    return [json.loads(row[0]) for row in rows]


def block_count() -> int:
    with _lock:
        row = _connection().execute("SELECT COUNT(*) FROM blocks").fetchone()
    return int(row[0])


def append_block(block: dict[str, Any]) -> None:
    with _lock:
        conn = _connection()
        conn.execute(
            "INSERT OR REPLACE INTO blocks (idx, hash, payload) VALUES (?, ?, ?)",
            (int(block["index"]), str(block.get("hash", "")), json.dumps(block)),
        )
        conn.commit()


def replace_all(blocks: list[dict[str, Any]]) -> None:
    with _lock:
        conn = _connection()
        conn.execute("DELETE FROM blocks")
        conn.executemany(
            "INSERT INTO blocks (idx, hash, payload) VALUES (?, ?, ?)",
            [
                (int(block["index"]), str(block.get("hash", "")), json.dumps(block))
                for block in blocks
            ],
        )
        conn.commit()


def migrate_from_json(json_path: Path) -> int:
    """One-time import of the legacy chain.json into SQLite. Returns blocks imported."""
    if block_count() > 0 or not json_path.exists():
        return 0
    payload = json.loads(json_path.read_text())
    if not isinstance(payload, list) or not payload:
        return 0
    replace_all(payload)
    return len(payload)
