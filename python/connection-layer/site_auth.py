"""Website username/password auth for marketing pages (e.g. /simulate).

Users and sessions are stored under connection-layer/data/ (gitignored).
Passwords are never logged; hashes use PBKDF2-HMAC-SHA256.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "data"
USERS_PATH = DATA_DIR / "site_users.json"
SESSIONS_PATH = DATA_DIR / "site_sessions.json"

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,32}$")
MIN_PASSWORD_LEN = 8
SESSION_DAYS = 30
PBKDF2_ITERS = 210_000
TOKEN_BYTES = 32  # secrets.token_urlsafe(32)

_lock = threading.Lock()


class SiteAuthError(Exception):
    def __init__(self, message: str, *, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def _write_json(path: Path, data: Any) -> None:
    _ensure_data_dir()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _load_users() -> dict[str, dict[str, Any]]:
    raw = _read_json(USERS_PATH, {"users": {}})
    users = raw.get("users") if isinstance(raw, dict) else None
    return users if isinstance(users, dict) else {}


def _save_users(users: dict[str, dict[str, Any]]) -> None:
    _write_json(USERS_PATH, {"users": users})


def _load_sessions() -> dict[str, dict[str, Any]]:
    raw = _read_json(SESSIONS_PATH, {"sessions": {}})
    sessions = raw.get("sessions") if isinstance(raw, dict) else None
    return sessions if isinstance(sessions, dict) else {}


def _save_sessions(sessions: dict[str, dict[str, Any]]) -> None:
    _write_json(SESSIONS_PATH, {"sessions": sessions})


def normalize_username(username: str) -> str:
    return str(username or "").strip().lower()


def validate_username(username: str) -> str:
    u = normalize_username(username)
    if not USERNAME_RE.match(u):
        raise SiteAuthError(
            "Username must be 3–32 characters: letters, numbers, underscore.",
            status=400,
        )
    return u


def validate_password(password: str) -> str:
    pw = str(password or "")
    if len(pw) < MIN_PASSWORD_LEN:
        raise SiteAuthError(f"Password must be at least {MIN_PASSWORD_LEN} characters.", status=400)
    if len(pw) > 256:
        raise SiteAuthError("Password is too long.", status=400)
    return pw


def _hash_password(password: str, *, salt: bytes | None = None) -> str:
    salt_b = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt_b,
        PBKDF2_ITERS,
    )
    return f"pbkdf2_sha256${PBKDF2_ITERS}${salt_b.hex()}${digest.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters_s, salt_hex, hash_hex = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        iters = int(iters_s)
        salt_b = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, TypeError):
        return False
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt_b,
        iters,
    )
    return hmac.compare_digest(digest, expected)


def _purge_expired(sessions: dict[str, dict[str, Any]], *, now: float | None = None) -> bool:
    t = now if now is not None else time.time()
    expired = [tok for tok, s in sessions.items() if float(s.get("expires", 0)) <= t]
    for tok in expired:
        sessions.pop(tok, None)
    return bool(expired)


def _create_session(username: str) -> str:
    token = secrets.token_urlsafe(TOKEN_BYTES)
    expires = time.time() + SESSION_DAYS * 86400
    with _lock:
        sessions = _load_sessions()
        _purge_expired(sessions)
        sessions[token] = {
            "username": username,
            "expires": expires,
            "created_at": time.time(),
        }
        _save_sessions(sessions)
    return token


def create_user(
    username: str,
    password: str,
    *,
    display: str | None = None,
    exist_ok: bool = False,
) -> dict[str, Any]:
    """Create a user without starting a session. Does not log password."""
    u = validate_username(username)
    pw = validate_password(password)
    disp = (display or "").strip()[:64] or None

    with _lock:
        users = _load_users()
        if u in users:
            if exist_ok:
                return {"ok": True, "username": u, "created": False}
            raise SiteAuthError("Username already taken.", status=409)
        users[u] = {
            "username": u,
            "password_hash": _hash_password(pw),
            "created_at": time.time(),
            "display": disp,
        }
        _save_users(users)

    return {"ok": True, "username": u, "created": True}


def signup(username: str, password: str, *, display: str | None = None) -> dict[str, Any]:
    """Create a user and return a session. Does not log password."""
    result = create_user(username, password, display=display, exist_ok=False)
    u = result["username"]
    token = _create_session(u)
    return {"ok": True, "username": u, "token": token, "expires_days": SESSION_DAYS}


def login(username: str, password: str) -> dict[str, Any]:
    """Authenticate and return a session. Does not log password."""
    u = normalize_username(username)
    pw = str(password or "")
    if not u or not pw:
        raise SiteAuthError("Username and password required.", status=400)

    with _lock:
        users = _load_users()
        row = users.get(u)

    # Constant-ish failure path: still hash against dummy when missing
    if not row or not _verify_password(pw, str(row.get("password_hash") or "")):
        raise SiteAuthError("Invalid username or password.", status=401)

    token = _create_session(u)
    return {"ok": True, "username": u, "token": token, "expires_days": SESSION_DAYS}


def logout(token: str | None) -> dict[str, Any]:
    if not token:
        return {"ok": True}
    with _lock:
        sessions = _load_sessions()
        sessions.pop(token, None)
        _purge_expired(sessions)
        _save_sessions(sessions)
    return {"ok": True}


def session_user(token: str | None) -> str | None:
    if not token:
        return None
    now = time.time()
    with _lock:
        sessions = _load_sessions()
        changed = _purge_expired(sessions, now=now)
        row = sessions.get(token)
        if not row:
            if changed:
                _save_sessions(sessions)
            return None
        if float(row.get("expires", 0)) <= now:
            sessions.pop(token, None)
            _save_sessions(sessions)
            return None
        if changed:
            _save_sessions(sessions)
        return str(row.get("username") or "") or None


def cookie_name() -> str:
    return "noeti_session"


def set_password(
    username: str,
    password: str,
    *,
    display: str | None = None,
    bypass_min_len: bool = False,
) -> dict[str, Any]:
    """Create or update a user's password. Does not log password."""
    u = validate_username(username)
    if bypass_min_len:
        pw = str(password or "")
        if not pw or len(pw) > 256:
            raise SiteAuthError("Invalid password.", status=400)
    else:
        pw = validate_password(password)
    disp = (display or "").strip()[:64] or None
    with _lock:
        users = _load_users()
        row = users.get(u) or {"username": u, "created_at": time.time()}
        row["password_hash"] = _hash_password(pw)
        if disp:
            row["display"] = disp
        elif "display" not in row:
            row["display"] = u
        users[u] = row
        _save_users(users)
    return {"ok": True, "username": u}


def ensure_bootstrap_admin(
    username: str = "admin",
    password: str = "admin",
    *,
    force_password: bool = True,
) -> dict[str, Any]:
    """Ensure the maker admin account exists (default admin/admin)."""
    try:
        if force_password:
            return set_password(
                username, password, display="Admin", bypass_min_len=True
            )
        return create_user(username, password, display="Admin", exist_ok=True)
    except SiteAuthError as exc:
        return {"ok": False, "error": exc.message}
