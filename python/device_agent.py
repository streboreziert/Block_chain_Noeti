#!/usr/bin/env python3
"""Noeti device agent — run on your PC.

Canvas + Editor send jobs here:
  · infer  → local Ollama
  · script → local language runtimes (python, node, …)

Usage:
  python3 device_agent.py --session dev_xxx --token TOKEN
  python3 device_agent.py --pair-url 'https://noeticompute.com/device?s=...&t=...'

Requires local Ollama for models (https://ollama.com). Scripts use tools on PATH.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
DEFAULT_HUB = os.environ.get("NOETI_HUB", "https://noeticompute.com").rstrip("/")

LANG_BINS = {
    "python": ["python3", "python"],
    "javascript": ["node"],
    "ruby": ["ruby"],
    "perl": ["perl"],
    "php": ["php"],
    "lua": ["lua", "lua5.4", "lua5.3"],
    "bash": ["bash"],
    "r": ["Rscript"],
    "go": ["go"],
    "rust": ["rustc"],
    "c": ["cc", "gcc", "clang"],
    "cpp": ["c++", "g++", "clang++"],
    "java": ["javac"],
}

EXT = {
    "python": ".py", "javascript": ".js", "ruby": ".rb", "perl": ".pl",
    "php": ".php", "lua": ".lua", "bash": ".sh", "r": ".R",
    "go": ".go", "rust": ".rs", "c": ".c", "cpp": ".cpp", "java": ".java",
}


def http_json(method: str, url: str, body: dict | None = None, timeout: float = 60) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except Exception:
            return {"ok": False, "error": "http", "message": f"{e.code}: {raw[:200]}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "network", "message": str(e)}


def which_lang(lang: str) -> str | None:
    for cand in LANG_BINS.get(lang, []):
        p = shutil.which(cand)
        if p:
            return p
    return None


def list_ollama_models() -> tuple[bool, list[str]]:
    try:
        with urllib.request.urlopen(f"{OLLAMA}/api/tags", timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        names = []
        for m in data.get("models") or []:
            name = m.get("name") or m.get("model") or ""
            if name:
                names.append(name)
        return True, names
    except Exception:
        return False, []


def ollama_chat(messages: list[dict[str, Any]], model: str, temperature: float = 0.55) -> dict[str, Any]:
    online, installed = list_ollama_models()
    if not online:
        return {"ok": False, "error": "Ollama not running. Start it with: ollama serve"}
    pick = model
    if pick and pick not in installed:
        stem = pick.split(":")[0]
        hit = next((m for m in installed if m == pick or m.startswith(stem + ":")), None)
        pick = hit or (installed[0] if installed else pick)
    if not pick:
        pick = installed[0] if installed else "qwen2.5:0.5b"
    payload = {
        "model": pick,
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature},
    }
    try:
        req = urllib.request.Request(
            f"{OLLAMA}/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        msg = (data.get("message") or {}).get("content") or data.get("response") or ""
        return {"ok": True, "reply": msg, "model": pick}
    except Exception:
        prompt = "\n".join(f"{m.get('role','user')}: {m.get('content','')}" for m in messages)
        gen = {"model": pick, "prompt": prompt, "stream": False, "options": {"temperature": temperature}}
        try:
            req = urllib.request.Request(
                f"{OLLAMA}/api/generate",
                data=json.dumps(gen).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return {"ok": True, "reply": data.get("response") or "", "model": pick}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e), "model": pick}


def run_local_script(script: dict[str, Any]) -> dict[str, Any]:
    """Execute Editor/Canvas script on THIS PC."""
    lang = str(script.get("lang") or "python").strip().lower()
    if lang in ("js", "node", "mjs"):
        lang = "javascript"
    if lang in ("py", "python3"):
        lang = "python"
    if lang in ("sh", "shell", "zsh"):
        lang = "bash"
    source = str(script.get("source") or "")
    upstream = str(script.get("input") or script.get("upstream") or "")
    timeout = float(script.get("timeout") or 25)
    meta = script.get("meta") if isinstance(script.get("meta"), dict) else {}

    if not source.strip():
        return {"ok": False, "error": "Empty source", "output": "", "explain": ""}

    banned = [
        r"\bos\.system\b", r"\bsubprocess\b", r"\bsocket\b", r"\burllib\b",
        r"\brequests\b", r"\bctypes\b", r"\bchild_process\b", r"\bsystem\s*\(",
        r"`[^`]*rm\s+-rf",
    ]
    for pat in banned:
        if re.search(pat, source, flags=re.I):
            return {"ok": False, "error": f"Blocked for safety: {pat}", "output": "", "explain": "Unsafe pattern"}

    tool = which_lang(lang)
    if not tool and lang == "java":
        # need java too for run
        if not shutil.which("javac") or not shutil.which("java"):
            tool = None
        else:
            tool = shutil.which("javac")
    if not tool:
        return {
            "ok": False,
            "error": f"{lang} not found on this PC — install it or pick another language",
            "output": "",
            "explain": f"No toolchain for {lang} on PATH",
        }

    work = Path(tempfile.mkdtemp(prefix="noeti_pc_"))
    try:
        ext = EXT.get(lang, ".txt")
        src_path = work / ("Main.java" if lang == "java" else f"snap{ext}")
        src_path.write_text(source, encoding="utf-8")
        payload = {"input": upstream, "upstream": upstream, "meta": meta}
        stdin = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        if lang == "python":
            cmd = [tool, str(src_path)]
        elif lang == "javascript":
            cmd = [tool, str(src_path)]
        elif lang == "ruby":
            cmd = [tool, str(src_path)]
        elif lang == "perl":
            cmd = [tool, str(src_path)]
        elif lang == "php":
            cmd = [tool, str(src_path)]
        elif lang == "lua":
            cmd = [tool, str(src_path)]
        elif lang == "bash":
            cmd = [tool, str(src_path)]
        elif lang == "r":
            cmd = [tool, str(src_path)]
        elif lang == "go":
            cmd = [tool, "run", str(src_path)]
        elif lang == "c":
            out_bin = work / "a.out"
            compile_cmd = [tool, str(src_path), "-o", str(out_bin)]
            c = subprocess.run(compile_cmd, capture_output=True, timeout=min(timeout, 20), cwd=str(work))
            if c.returncode != 0:
                err = (c.stderr or c.stdout or b"").decode("utf-8", errors="replace")
                return {"ok": False, "error": err[:2000], "output": err, "explain": "C compile failed"}
            cmd = [str(out_bin)]
        elif lang == "cpp":
            out_bin = work / "a.out"
            compile_cmd = [tool, str(src_path), "-o", str(out_bin)]
            c = subprocess.run(compile_cmd, capture_output=True, timeout=min(timeout, 20), cwd=str(work))
            if c.returncode != 0:
                err = (c.stderr or c.stdout or b"").decode("utf-8", errors="replace")
                return {"ok": False, "error": err[:2000], "output": err, "explain": "C++ compile failed"}
            cmd = [str(out_bin)]
        elif lang == "rust":
            out_bin = work / "a.out"
            compile_cmd = [tool, str(src_path), "-o", str(out_bin)]
            c = subprocess.run(compile_cmd, capture_output=True, timeout=min(timeout, 30), cwd=str(work))
            if c.returncode != 0:
                err = (c.stderr or c.stdout or b"").decode("utf-8", errors="replace")
                return {"ok": False, "error": err[:2000], "output": err, "explain": "Rust compile failed"}
            cmd = [str(out_bin)]
        elif lang == "java":
            c = subprocess.run([tool, str(src_path)], capture_output=True, timeout=min(timeout, 25), cwd=str(work))
            if c.returncode != 0:
                err = (c.stderr or c.stdout or b"").decode("utf-8", errors="replace")
                return {"ok": False, "error": err[:2000], "output": err, "explain": "Java compile failed"}
            java = shutil.which("java") or "java"
            cmd = [java, "-cp", str(work), "Main"]
        else:
            return {"ok": False, "error": f"Unsupported language: {lang}", "output": "", "explain": ""}

        t0 = time.time()
        proc = subprocess.run(
            cmd,
            input=stdin,
            capture_output=True,
            timeout=timeout,
            cwd=str(work),
            env={
                **os.environ,
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )
        ms = int((time.time() - t0) * 1000)
        stdout = (proc.stdout or b"").decode("utf-8", errors="replace")
        stderr = (proc.stderr or b"").decode("utf-8", errors="replace")
        text = stdout.strip() or stderr.strip()
        # Prefer JSON contract if present
        explain = f"Ran on this PC · {lang} · {ms}ms"
        metrics: dict[str, Any] = {"ms": ms, "lang": lang, "host": socket.gethostname()}
        output = text
        ok = proc.returncode == 0
        try:
            parsed = json.loads(stdout)
            if isinstance(parsed, dict):
                ok = bool(parsed.get("ok", ok))
                output = str(parsed.get("output") if parsed.get("output") is not None else stdout)
                explain = str(parsed.get("explain") or explain)
                if isinstance(parsed.get("metrics"), dict):
                    metrics.update(parsed["metrics"])
        except Exception:
            pass
        if not ok and stderr and not output:
            output = stderr
        return {
            "ok": ok,
            "output": output[:50000],
            "reply": output[:50000],
            "explain": explain,
            "metrics": metrics,
            "error": "" if ok else (stderr[:500] or f"exit {proc.returncode}"),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Timed out after {timeout}s", "output": "", "explain": "Timeout on PC"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e), "output": "", "explain": "PC script error"}
    finally:
        try:
            for p in work.glob("**/*"):
                if p.is_file():
                    p.unlink(missing_ok=True)  # type: ignore[arg-type]
            work.rmdir()
        except Exception:
            pass


def parse_pair_url(url: str) -> tuple[str, str, str]:
    u = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(u.query)
    sid = (qs.get("s") or [""])[0]
    token = (qs.get("t") or [""])[0]
    hub = f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else DEFAULT_HUB
    return hub.rstrip("/"), sid, token


def run(hub: str, session_id: str, token: str, label: str = "") -> int:
    print("Noeti device agent · local PC")
    print(f"  hub     {hub}")
    print(f"  session {session_id}")
    print(f"  host    {socket.gethostname()} · {platform.system()}")
    online, models = list_ollama_models()
    print(f"  ollama  {'online · ' + ', '.join(models[:6]) if online else 'OFFLINE — run: ollama serve'}")
    ready_langs = [k for k in LANG_BINS if which_lang(k)]
    print(f"  scripts {', '.join(ready_langs[:8]) or 'none detected'}")

    fail = 0
    while True:
        online, models = list_ollama_models()
        hb = http_json(
            "POST",
            f"{hub}/api/canvas/device/heartbeat",
            {
                "session_id": session_id,
                "token": token,
                "models": models,
                "ollama": online,
                "hostname": socket.gethostname(),
                "platform": f"{platform.system()} {platform.machine()}",
                "label": label or socket.gethostname(),
            },
            timeout=15,
        )
        if not hb.get("ok"):
            fail += 1
            print(f"! heartbeat: {hb.get('message') or hb.get('error') or hb}")
            if fail > 8:
                print("Too many heartbeat failures — check pair link / network")
                return 1
            time.sleep(3)
            continue
        fail = 0

        claim = http_json(
            "GET",
            f"{hub}/api/canvas/device/jobs?s={urllib.parse.quote(session_id)}&t={urllib.parse.quote(token)}",
            timeout=20,
        )
        job = (claim or {}).get("job")
        if not job:
            time.sleep(1.5)
            continue

        job_id = job.get("id")
        kind = (job.get("kind") or "infer").lower()
        print(f"→ job {job_id} · {kind}")
        t0 = time.time()

        if kind == "script":
            out = run_local_script(job.get("script") or {})
            ms = int((time.time() - t0) * 1000)
            res = http_json(
                "POST",
                f"{hub}/api/canvas/device/result",
                {
                    "session_id": session_id,
                    "token": token,
                    "job_id": job_id,
                    "kind": "script",
                    "ok": bool(out.get("ok")),
                    "reply": out.get("reply") or out.get("output") or "",
                    "output": out.get("output") or "",
                    "explain": out.get("explain") or "",
                    "metrics": out.get("metrics") or {},
                    "error": out.get("error") or "",
                    "latency_ms": ms,
                },
                timeout=30,
            )
        else:
            messages = job.get("messages") or []
            if not messages and job.get("prompt"):
                messages = [{"role": "user", "content": job["prompt"]}]
            clean = []
            for m in messages:
                content = m.get("content")
                if isinstance(content, list):
                    text = " ".join(
                        (p.get("text") or "") for p in content if isinstance(p, dict) and p.get("type") == "text"
                    )
                    clean.append({"role": m.get("role") or "user", "content": text or "[image omitted on device agent]"})
                else:
                    clean.append({"role": m.get("role") or "user", "content": str(content or "")})

            if not online:
                out = {"ok": False, "error": "Ollama offline on this PC", "model": job.get("model") or ""}
            else:
                out = ollama_chat(clean, job.get("model") or "", float(job.get("temperature") or 0.55))

            ms = int((time.time() - t0) * 1000)
            res = http_json(
                "POST",
                f"{hub}/api/canvas/device/result",
                {
                    "session_id": session_id,
                    "token": token,
                    "job_id": job_id,
                    "kind": "infer",
                    "ok": bool(out.get("ok")),
                    "reply": out.get("reply") or "",
                    "model": out.get("model") or job.get("model") or "",
                    "error": out.get("error") or "",
                    "latency_ms": ms,
                },
                timeout=30,
            )

        if res.get("ok"):
            preview = (out.get("reply") or out.get("output") or out.get("error") or "")[:80]
            print(f"✓ done {ms}ms · {preview}")
        else:
            print(f"! result post failed: {res}")
        time.sleep(0.2)


def main() -> int:
    ap = argparse.ArgumentParser(description="Noeti local PC agent (models + scripts)")
    ap.add_argument("--hub", default=DEFAULT_HUB)
    ap.add_argument("--session", default="")
    ap.add_argument("--token", default="")
    ap.add_argument("--pair-url", default="")
    ap.add_argument("--label", default="")
    args = ap.parse_args()
    hub, sid, token = args.hub.rstrip("/"), args.session, args.token
    if args.pair_url:
        hub, sid, token = parse_pair_url(args.pair_url)
    if not sid or not token:
        print("Need --session and --token, or --pair-url")
        return 2
    try:
        return run(hub, sid, token, label=args.label)
    except KeyboardInterrupt:
        print("\nStopped")
        return 0


if __name__ == "__main__":
    sys.exit(main())
