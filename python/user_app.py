#!/usr/bin/env python3
"""Standalone Noetis user app — local UI + wallet + terminal (not hosted on the hub website)."""

from __future__ import annotations

import argparse
import webbrowser
from pathlib import Path

from flask import Flask, make_response, send_from_directory

ROOT = Path(__file__).resolve().parent
CLIENT = ROOT / "client"

app = Flask(__name__, static_folder=str(CLIENT / "static"), static_url_path="/static")


@app.route("/")
def index() -> object:
    html = (CLIENT / "app.html").read_text(encoding="utf-8")
    hub = app.config.get("HUB_URL", "").rstrip("/")
    html = html.replace("{{HUB_URL}}", hub)
    return make_response(html)


@app.route("/favicon.ico")
def favicon() -> object:
    return send_from_directory(CLIENT / "static", "logo.svg")


def main() -> None:
    parser = argparse.ArgumentParser(description="Noetis standalone user app")
    parser.add_argument("--hub", required=True, help="Network entry / hub URL")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5056)
    parser.add_argument("--open", action="store_true", help="Open browser")
    args = parser.parse_args()

    hub = args.hub.rstrip("/")
    app.config["HUB_URL"] = hub
    url = f"http://{args.host}:{args.port}"

    print("")
    print("  Noetis User App (standalone)")
    print(f"  Hub:     {hub}")
    print(f"  Local:   {url}")
    print("  Wallet + terminal run locally — hub website is discovery only.")
    print("")

    if args.open:
        webbrowser.open(url)

    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
