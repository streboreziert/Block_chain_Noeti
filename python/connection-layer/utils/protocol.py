"""JSON-line socket protocol helpers."""

from __future__ import annotations

import json
import socket
from typing import Any


def send_message(conn: socket.socket, message: dict[str, Any]) -> None:
    payload = (json.dumps(message) + "\n").encode("utf-8")
    conn.sendall(payload)


def read_message(conn: socket.socket, buffer: bytearray | None = None) -> tuple[dict[str, Any], bytearray]:
    buf = buffer if buffer is not None else bytearray()
    while True:
        if b"\n" in buf:
            line, remainder = buf.split(b"\n", 1)
            return json.loads(line.decode("utf-8")), bytearray(remainder)

        chunk = conn.recv(65536)
        if not chunk:
            raise ConnectionError("Connection closed")
        buf.extend(chunk)


def normalize_response(text: str) -> str:
    """Normalize model output for consensus comparison."""
    return " ".join(text.strip().lower().split())
