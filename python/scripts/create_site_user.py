#!/usr/bin/env python3
"""Create a website (site_auth) user — local or inside the network container.

Examples:
  python3 scripts/create_site_user.py --username admin --password '...'
  python3 scripts/create_site_user.py --username team --password '...' --if-missing
  python3 scripts/create_site_user.py --ensure-team
    # reads SITE_USER_ADMIN_PASSWORD, SITE_USER_TEAM_PASSWORD, SITE_USER_OPS_PASSWORD
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONNECTION = ROOT / "connection-layer"
sys.path.insert(0, str(CONNECTION))

from site_auth import SiteAuthError, create_user, normalize_username, set_password  # noqa: E402


TEAM_DEFAULTS = ("admin", "team", "ops")


def _create_one(username: str, password: str, *, if_missing: bool, display: str | None, force: bool = False) -> int:
    try:
        if force:
            set_password(username, password, display=display, bypass_min_len=True)
            print(f"updated user: {normalize_username(username)}")
            return 0
        result = create_user(username, password, display=display, exist_ok=if_missing)
    except SiteAuthError as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return 1
    u = result["username"]
    if result.get("created"):
        print(f"created user: {u}")
    else:
        print(f"exists (skipped): {u}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a Noeti site auth user")
    parser.add_argument("--username", help="Username (normalized to lowercase)")
    parser.add_argument("--password", help="Password (min 8 chars); prefer env SITE_USER_PASSWORD")
    parser.add_argument("--display", default=None, help="Optional display name")
    parser.add_argument(
        "--if-missing",
        action="store_true",
        help="Do not fail if the username already exists",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Create or overwrite password for the user",
    )
    parser.add_argument(
        "--ensure-team",
        action="store_true",
        help="Create admin/team/ops from SITE_USER_*_PASSWORD env vars (if-missing)",
    )
    args = parser.parse_args()

    if args.ensure_team:
        mapping = {
            "admin": os.environ.get("SITE_USER_ADMIN_PASSWORD", ""),
            "team": os.environ.get("SITE_USER_TEAM_PASSWORD", ""),
            "ops": os.environ.get("SITE_USER_OPS_PASSWORD", ""),
        }
        force = os.environ.get("SITE_USER_FORCE", "").strip() in ("1", "true", "yes") or args.force
        rc = 0
        for username in TEAM_DEFAULTS:
            pw = (mapping.get(username) or "").strip()
            if not pw:
                print(f"skip {username}: no SITE_USER_{username.upper()}_PASSWORD", file=sys.stderr)
                continue
            rc = max(rc, _create_one(username, pw, if_missing=True, display=None, force=force))
        return rc

    username = args.username
    password = args.password or os.environ.get("SITE_USER_PASSWORD", "")
    if not username or not password:
        parser.error("--username and --password (or SITE_USER_PASSWORD) are required")

    print(f"target user: {normalize_username(username)}", file=sys.stderr)
    return _create_one(
        username,
        password,
        if_missing=args.if_missing,
        display=args.display,
        force=args.force,
    )


if __name__ == "__main__":
    raise SystemExit(main())
