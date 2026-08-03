#!/usr/bin/env python3
"""Canvas local compute: auto Ollama install/serve + multi-language snap-in scripts.

Any common language that is installed on the machine can snap into a workflow.
Scripts keep an explainable contract:

  stdin  → JSON {"input","upstream","meta"}  (compiled langs may get plain text)
  stdout → JSON {"ok","output","explain","metrics"}  OR plain text
"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

DEFAULT_MODEL = os.environ.get("NOETI_LOCAL_MODEL", "qwen2.5:1.5b")
FALLBACK_MODELS = [
    m for m in (
        DEFAULT_MODEL,
        os.environ.get("NOETI_LOCAL_MODEL_FALLBACK", "qwen2.5:0.5b"),
        "qwen2.5:1.5b",
        "qwen2.5:0.5b",
        "llama3.2:1b",
    ) if m
]
# Dedupe while preserving order
_seen = set()
FALLBACK_MODELS = [m for m in FALLBACK_MODELS if not (m in _seen or _seen.add(m))]
OLLAMA_CANDIDATES = [
    os.environ.get("OLLAMA_HOST", "").rstrip("/"),
    "http://127.0.0.1:11434",
    "http://localhost:11434",
    "http://ollama:11434",
]
MAX_SOURCE_BYTES = 160_000
MAX_INPUT_CHARS = 200_000
SCRIPT_TIMEOUT_SEC = 25
RUNTIME_DIR = Path(os.environ.get("NOETI_RUNTIME_DIR") or (Path.home() / ".noeti" / "runtime"))
PULL_LOCK = threading.Lock()
INSTALL_LOCK = threading.Lock()
_pull_state: dict[str, Any] = {"active": False, "model": "", "ok": None, "message": ""}
_install_state: dict[str, Any] = {
    "active": False,
    "phase": "idle",
    "ok": None,
    "message": "",
    "progress": 0,
    "bin": "",
}
_serve_proc: subprocess.Popen | None = None

# ---- templates (sum integers — deterministic, explainable) ----

PY_TEMPLATE = '''# Noeti · Python snap-in
import json, sys, re
payload = json.load(sys.stdin)
text = (payload.get("input") or "").strip()
nums = [int(x.replace(",", "")) for x in re.findall(r"-?\\d[\\d,]*(?=\\D|$)", text)]
print(json.dumps({
  "ok": True,
  "output": f"numbers={nums}\\nsum={sum(nums)}",
  "explain": f"Python regex integers → sum ({len(nums)} values).",
  "metrics": {"count": len(nums), "sum": sum(nums)},
}, ensure_ascii=False))
'''

JS_TEMPLATE = '''// Noeti · JavaScript (Node) snap-in
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8");
const payload = JSON.parse(raw || "{}");
const text = String(payload.input || payload.upstream || "");
const nums = (text.match(/-?\\d[\\d,]*(?=\\D|$)/g) || []).map((x) => Number(x.replace(/,/g, "")));
const sum = nums.reduce((a, b) => a + b, 0);
process.stdout.write(JSON.stringify({
  ok: true,
  output: `numbers=${JSON.stringify(nums)}\\nsum=${sum}`,
  explain: `Node parsed ${nums.length} integers locally.`,
  metrics: { count: nums.length, sum },
}));
'''

RB_TEMPLATE = '''# Noeti · Ruby snap-in
require "json"
payload = JSON.parse(STDIN.read)
text = (payload["input"] || payload["upstream"] || "").to_s
nums = text.scan(/-?\\d[\\d,]*(?=\\D|$)/).map { |x| x.delete(",").to_i }
sum = nums.sum
puts({
  ok: true,
  output: "numbers=#{nums.inspect}\\nsum=#{sum}",
  explain: "Ruby scanned #{nums.length} integers locally.",
  metrics: { count: nums.length, sum: sum },
}.to_json)
'''

PERL_TEMPLATE = '''# Noeti · Perl snap-in
use strict; use warnings; use JSON::PP qw(decode_json encode_json);
my $payload = decode_json(do { local $/; <STDIN> });
my $text = $payload->{input} // $payload->{upstream} // "";
my @nums = map { s/,//gr } ($text =~ /-?\\d[\\d,]*(?=\\D|$)/g);
my $sum = 0; $sum += $_ for @nums;
print encode_json({
  ok => JSON::PP::true,
  output => "numbers=[".join(",", @nums)."]\\nsum=$sum",
  explain => "Perl extracted ".scalar(@nums)." integers.",
  metrics => { count => scalar(@nums), sum => $sum+0 },
});
'''

BASH_TEMPLATE = '''#!/usr/bin/env bash
# Noeti · Bash snap-in — reads JSON; emits JSON
input=$(cat)
text=$(printf '%s' "$input" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("input") or d.get("upstream") or "")' 2>/dev/null || true)
nums=$(printf '%s' "$text" | grep -oE -- '-?[0-9][0-9,]*' | tr -d ',' | paste -sd' ' -)
sum=0; count=0
for n in $nums; do sum=$((sum+n)); count=$((count+1)); done
printf '{"ok":true,"output":"numbers=%s\\nsum=%s","explain":"Bash summed %s integers via grep.","metrics":{"count":%s,"sum":%s}}\\n' \
  "[$nums]" "$sum" "$count" "$count" "$sum"
'''

C_TEMPLATE = r'''/* Noeti · C snap-in — stdin = plain upstream text */
#include <stdio.h>
#include <ctype.h>
int main(void) {
  char buf[65536]; size_t n = fread(buf, 1, sizeof(buf)-1, stdin); buf[n]=0;
  long sum=0; int count=0;
  for (size_t i=0;i<n;) {
    int sign=1;
    if (buf[i]=='-' && i+1<n && isdigit((unsigned char)buf[i+1])) { sign=-1; i++; }
    if (isdigit((unsigned char)buf[i])) {
      long v=0; while (i<n && (isdigit((unsigned char)buf[i]) || buf[i]==',')) {
        if (buf[i]!=',') v=v*10+(buf[i]-'0'); i++;
      }
      sum += sign*v; count++;
    } else i++;
  }
  printf("{\"ok\":true,\"output\":\"numbers=%d sum=%ld\",\"explain\":\"C walker summed ints locally.\",\"metrics\":{\"count\":%d,\"sum\":%ld}}\n",
         count, sum, count, sum);
  return 0;
}
'''

CPP_TEMPLATE = r'''// Noeti · C++ snap-in — stdin = plain upstream text
#include <iostream>
#include <string>
#include <cctype>
int main() {
  std::string s((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
  long sum=0; int count=0;
  for (size_t i=0;i<s.size();) {
    int sign=1;
    if (s[i]=='-' && i+1<s.size() && std::isdigit(static_cast<unsigned char>(s[i+1]))) { sign=-1; ++i; }
    if (std::isdigit(static_cast<unsigned char>(s[i]))) {
      long v=0; while (i<s.size() && (std::isdigit(static_cast<unsigned char>(s[i])) || s[i]==',')) {
        if (s[i]!=',') v=v*10+(s[i]-'0'); ++i;
      }
      sum += sign*v; ++count;
    } else ++i;
  }
  std::cout << "{\"ok\":true,\"output\":\"numbers=" << count << " sum=" << sum
            << "\",\"explain\":\"C++ walker summed ints locally.\",\"metrics\":{\"count\":"
            << count << ",\"sum\":" << sum << "}}\n";
}
'''

RS_TEMPLATE = r'''// Noeti · Rust snap-in — stdin = plain upstream text
use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).ok();
    let bytes = s.as_bytes();
    let mut i = 0usize; let mut sum: i64 = 0; let mut count = 0i32;
    while i < bytes.len() {
        let mut sign = 1i64;
        if bytes[i] == b'-' && i+1 < bytes.len() && bytes[i+1].is_ascii_digit() { sign = -1; i += 1; }
        if bytes[i].is_ascii_digit() {
            let mut v = 0i64;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b',') {
                if bytes[i] != b',' { v = v*10 + (bytes[i]-b'0') as i64; }
                i += 1;
            }
            sum += sign * v; count += 1;
        } else { i += 1; }
    }
    println!("{{\"ok\":true,\"output\":\"numbers={} sum={}\",\"explain\":\"Rust walker summed ints locally.\",\"metrics\":{{\"count\":{},\"sum\":{}}}}}", count, sum, count, sum);
}
'''

GO_TEMPLATE = r'''// Noeti · Go snap-in — stdin = plain upstream text
package main
import ("fmt"; "io"; "os"; "unicode")
func main() {
  b, _ := io.ReadAll(os.Stdin)
  s := string(b); sum := int64(0); count := 0
  for i := 0; i < len(s); {
    sign := int64(1)
    if s[i]=='-' && i+1<len(s) && unicode.IsDigit(rune(s[i+1])) { sign = -1; i++ }
    if unicode.IsDigit(rune(s[i])) {
      var v int64
      for i < len(s) && (unicode.IsDigit(rune(s[i])) || s[i]==',') {
        if s[i] != ',' { v = v*10 + int64(s[i]-'0') }
        i++
      }
      sum += sign * v; count++
    } else { i++ }
  }
  fmt.Printf("{\"ok\":true,\"output\":\"numbers=%d sum=%d\",\"explain\":\"Go walker summed ints locally.\",\"metrics\":{\"count\":%d,\"sum\":%d}}\n", count, sum, count, sum)
}
'''

JAVA_TEMPLATE = r'''// Noeti · Java snap-in — class must be Main
import java.io.*;
public class Main {
  public static void main(String[] args) throws Exception {
    String s = new String(System.in.readAllBytes());
    long sum=0; int count=0;
    for (int i=0;i<s.length();) {
      int sign=1;
      if (s.charAt(i)=='-' && i+1<s.length() && Character.isDigit(s.charAt(i+1))) { sign=-1; i++; }
      if (Character.isDigit(s.charAt(i))) {
        long v=0;
        while (i<s.length() && (Character.isDigit(s.charAt(i)) || s.charAt(i)==',')) {
          if (s.charAt(i)!=',') v=v*10+(s.charAt(i)-'0');
          i++;
        }
        sum += sign*v; count++;
      } else i++;
    }
    System.out.printf("{\"ok\":true,\"output\":\"numbers=%d sum=%d\",\"explain\":\"Java walker summed ints locally.\",\"metrics\":{\"count\":%d,\"sum\":%d}}%n", count, sum, count, sum);
  }
}
'''

PHP_TEMPLATE = '''<?php
// Noeti · PHP snap-in
$payload = json_decode(stream_get_contents(STDIN), true) ?: [];
$text = strval($payload["input"] ?? $payload["upstream"] ?? "");
preg_match_all('/-?\\d[\\d,]*(?=\\D|$)/', $text, $m);
$nums = array_map(fn($x) => intval(str_replace(",", "", $x)), $m[0] ?? []);
$sum = array_sum($nums);
echo json_encode([
  "ok" => true,
  "output" => "numbers=[".implode(",", $nums)."]\\nsum=$sum",
  "explain" => "PHP extracted ".count($nums)." integers.",
  "metrics" => ["count" => count($nums), "sum" => $sum],
], JSON_UNESCAPED_UNICODE);
'''

LUA_TEMPLATE = '''-- Noeti · Lua snap-in (plain output OK)
local text = io.read("*a") or ""
local sum, count = 0, 0
for num in text:gmatch("-?%d[%d,]*") do
  local n = tonumber((num:gsub(",",""))) or 0
  sum = sum + n; count = count + 1
end
print(string.format('{"ok":true,"output":"numbers=%d sum=%d","explain":"Lua summed ints.","metrics":{"count":%d,"sum":%d}}', count, sum, count, sum))
'''

R_TEMPLATE = '''# Noeti · R snap-in
raw <- paste(readLines("stdin", warn=FALSE), collapse="\\n")
payload <- tryCatch(jsonlite::fromJSON(raw), error=function(e) list(input=raw))
text <- as.character(payload$input %||% payload$upstream %||% raw)
nums <- as.numeric(gsub(",", "", regmatches(text, gregexpr("-?[0-9][0-9,]*", text))[[1]]))
nums <- nums[!is.na(nums)]
cat(sprintf('{"ok":true,"output":"numbers=%s\\nsum=%s","explain":"R extracted %d integers.","metrics":{"count":%d,"sum":%s}}\\n',
  paste(nums, collapse=","), sum(nums), length(nums), length(nums), sum(nums)))
'''

LANG_CATALOG: list[dict[str, Any]] = [
    {"id": "python", "label": "Python", "ext": ".py", "group": "script", "json_stdin": True, "template": PY_TEMPLATE},
    {"id": "javascript", "label": "JavaScript", "ext": ".js", "group": "script", "json_stdin": True, "template": JS_TEMPLATE},
    {"id": "ruby", "label": "Ruby", "ext": ".rb", "group": "script", "json_stdin": True, "template": RB_TEMPLATE},
    {"id": "perl", "label": "Perl", "ext": ".pl", "group": "script", "json_stdin": True, "template": PERL_TEMPLATE},
    {"id": "bash", "label": "Bash", "ext": ".sh", "group": "script", "json_stdin": True, "template": BASH_TEMPLATE},
    {"id": "php", "label": "PHP", "ext": ".php", "group": "script", "json_stdin": True, "template": PHP_TEMPLATE},
    {"id": "lua", "label": "Lua", "ext": ".lua", "group": "script", "json_stdin": False, "template": LUA_TEMPLATE},
    {"id": "r", "label": "R", "ext": ".R", "group": "script", "json_stdin": True, "template": R_TEMPLATE},
    {"id": "c", "label": "C", "ext": ".c", "group": "compiled", "json_stdin": False, "template": C_TEMPLATE},
    {"id": "cpp", "label": "C++", "ext": ".cpp", "group": "compiled", "json_stdin": False, "template": CPP_TEMPLATE},
    {"id": "rust", "label": "Rust", "ext": ".rs", "group": "compiled", "json_stdin": False, "template": RS_TEMPLATE},
    {"id": "go", "label": "Go", "ext": ".go", "group": "compiled", "json_stdin": False, "template": GO_TEMPLATE},
    {"id": "java", "label": "Java", "ext": ".java", "group": "compiled", "json_stdin": False, "template": JAVA_TEMPLATE},
]


def _which_any(*names: str) -> str:
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return ""


def resolve_tool(lang: str) -> dict[str, Any]:
    lang = _norm_lang(lang)
    mapping: dict[str, Callable[[], dict[str, Any]]] = {
        "python": lambda: {"bin": _which_any("python3", "python"), "ready": bool(_which_any("python3", "python"))},
        "javascript": lambda: {"bin": _which_any("node"), "ready": bool(_which_any("node"))},
        "ruby": lambda: {"bin": _which_any("ruby"), "ready": bool(_which_any("ruby"))},
        "perl": lambda: {"bin": _which_any("perl"), "ready": bool(_which_any("perl"))},
        "bash": lambda: {"bin": _which_any("bash"), "ready": bool(_which_any("bash"))},
        "php": lambda: {"bin": _which_any("php"), "ready": bool(_which_any("php"))},
        "lua": lambda: {"bin": _which_any("lua", "luajit"), "ready": bool(_which_any("lua", "luajit"))},
        "r": lambda: {"bin": _which_any("Rscript"), "ready": bool(_which_any("Rscript"))},
        "c": lambda: {"bin": _which_any("cc", "clang", "gcc"), "ready": bool(_which_any("cc", "clang", "gcc"))},
        "cpp": lambda: {"bin": _which_any("c++", "clang++", "g++"), "ready": bool(_which_any("c++", "clang++", "g++"))},
        "rust": lambda: {"bin": _which_any("rustc"), "ready": bool(_which_any("rustc"))},
        "go": lambda: {"bin": _which_any("go"), "ready": bool(_which_any("go"))},
        "java": lambda: {
            "bin": _which_any("javac"),
            "ready": bool(_which_any("javac") and _which_any("java")),
            "java": _which_any("java"),
        },
    }
    fn = mapping.get(lang)
    if not fn:
        return {"bin": "", "ready": False}
    return fn()


def languages_status() -> list[dict[str, Any]]:
    out = []
    for row in LANG_CATALOG:
        tool = resolve_tool(row["id"])
        out.append(
            {
                **{k: row[k] for k in ("id", "label", "ext", "group")},
                "ready": bool(tool.get("ready")),
                "bin": tool.get("bin") or "",
                "template": row["template"],
            }
        )
    return out


def _http_json(url: str, method: str = "GET", body: dict | None = None, timeout: float = 3.0) -> Any:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        if not raw.strip():
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            last = {}
            for line in raw.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    last = json.loads(line)
                except json.JSONDecodeError:
                    continue
            return last


def resolve_ollama_host() -> str | None:
    for host in OLLAMA_CANDIDATES:
        if not host:
            continue
        try:
            _http_json(f"{host}/api/tags", timeout=1.2)
            return host
        except Exception:
            continue
    return None


def list_installed(host: str) -> list[str]:
    try:
        data = _http_json(f"{host}/api/tags", timeout=2.5)
        return [m.get("name") for m in (data.get("models") or []) if m.get("name")]
    except Exception:
        return []


def _ollama_asset() -> tuple[str, str]:
    sysname = platform.system().lower()
    machine = platform.machine().lower()
    if sysname == "darwin":
        return ("ollama-darwin.tgz", "tgz")
    if sysname == "linux":
        arch = "arm64" if "arm" in machine or "aarch" in machine else "amd64"
        return (f"ollama-linux-{arch}.tgz", "tgz")
    if sysname == "windows":
        return ("ollama-windows-amd64.zip", "zip")
    raise RuntimeError(f"Unsupported platform for auto-install: {sysname}/{machine}")


def _managed_ollama_bin() -> Path:
    name = "ollama.exe" if platform.system().lower() == "windows" else "ollama"
    return RUNTIME_DIR / "bin" / name


def _find_ollama_binary() -> str:
    managed = _managed_ollama_bin()
    if managed.exists():
        return str(managed)
    return _which_any("ollama")


def _start_ollama_serve(bin_path: str) -> dict[str, Any]:
    global _serve_proc
    host = resolve_ollama_host()
    if host:
        return {"ok": True, "already": True, "host": host, "message": f"Ollama already serving · {host}"}
    try:
        _serve_proc = subprocess.Popen(
            [bin_path, "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": f"Could not start ollama serve: {exc}"}
    for _ in range(40):
        time.sleep(0.35)
        host = resolve_ollama_host()
        if host:
            return {"ok": True, "started": True, "host": host, "pid": _serve_proc.pid, "message": f"Started Ollama · {host}"}
    return {"ok": False, "message": "Ollama started but API not reachable yet", "pid": getattr(_serve_proc, "pid", None)}


def _download_file(url: str, dest: Path, on_progress: Callable[[int], None] | None = None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "NoetiCanvas/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if on_progress and total:
                on_progress(int(done * 100 / total))
    tmp.replace(dest)


def _extract_ollama(archive: Path, kind: str) -> Path:
    import tarfile
    import zipfile

    out_dir = RUNTIME_DIR / "extract"
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    if kind == "tgz":
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(out_dir)
    else:
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(out_dir)
    # Find binary named ollama
    candidates = list(out_dir.rglob("ollama")) + list(out_dir.rglob("ollama.exe"))
    if not candidates:
        raise RuntimeError("Downloaded archive did not contain ollama binary")
    bin_path = _managed_ollama_bin()
    bin_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(candidates[0], bin_path)
    bin_path.chmod(0o755)
    return bin_path


def _install_worker() -> None:
    global _install_state
    try:
        _install_state.update({"active": True, "phase": "download", "progress": 2, "message": "Downloading Ollama…", "ok": None})
        asset, kind = _ollama_asset()
        url = f"https://github.com/ollama/ollama/releases/latest/download/{asset}"
        archive = RUNTIME_DIR / "cache" / asset

        def prog(p: int) -> None:
            _install_state.update({"progress": max(2, min(85, p)), "message": f"Downloading Ollama… {p}%"})

        _download_file(url, archive, on_progress=prog)
        _install_state.update({"phase": "extract", "progress": 88, "message": "Installing Ollama binary…"})
        bin_path = _extract_ollama(archive, kind)
        _install_state.update({"phase": "serve", "progress": 92, "message": "Starting local Ollama…", "bin": str(bin_path)})
        started = _start_ollama_serve(str(bin_path))
        if not started.get("ok"):
            _install_state.update({"active": False, "ok": False, "phase": "error", "progress": 100, "message": started.get("message")})
            return
        _install_state.update(
            {
                "active": False,
                "ok": True,
                "phase": "ready",
                "progress": 100,
                "message": started.get("message") or "Ollama ready",
                "bin": str(bin_path),
                "host": started.get("host"),
            }
        )
    except Exception as exc:  # noqa: BLE001
        _install_state.update({"active": False, "ok": False, "phase": "error", "progress": 100, "message": f"Install failed: {exc}"})


def ensure_ollama_installed(*, force: bool = False) -> dict[str, Any]:
    """Website-driven install: download Ollama into ~/.noeti/runtime and start serve."""
    host = resolve_ollama_host()
    if host and not force:
        return {"ok": True, "installed": True, "host": host, "message": f"Ollama online · {host}", "install": dict(_install_state)}

    existing = _find_ollama_binary()
    if existing and not force:
        started = _start_ollama_serve(existing)
        return {**started, "bin": existing, "install": dict(_install_state)}

    with INSTALL_LOCK:
        if _install_state.get("active"):
            return {"ok": True, "installing": True, "install": dict(_install_state), "message": _install_state.get("message")}
        _install_state.update({"active": True, "phase": "queued", "progress": 1, "ok": None, "message": "Queued Ollama install…"})
        threading.Thread(target=_install_worker, daemon=True).start()
    return {"ok": True, "installing": True, "install": dict(_install_state), "message": "Installing Ollama automatically…"}


def _pull_worker(host: str, model: str) -> None:
    global _pull_state
    try:
        req = urllib.request.Request(
            f"{host}/api/pull",
            data=json.dumps({"name": model, "stream": False}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=900) as resp:
            resp.read()
        _pull_state.update({"active": False, "ok": True, "message": f"Ready · {model}", "model": model})
    except Exception as exc:  # noqa: BLE001
        _pull_state.update({"active": False, "ok": False, "message": f"Pull failed: {exc}", "model": model})


def pick_installed_model(installed: list[str], preferred: str | None = None) -> str:
    """Prefer stronger on-node models when already pulled; else DEFAULT_MODEL."""
    prefs = []
    if preferred:
        prefs.append(preferred)
    prefs.extend(FALLBACK_MODELS)
    seen: set[str] = set()
    ordered = [m for m in prefs if not (m in seen or seen.add(m))]
    for cand in ordered:
        if cand in installed:
            return cand
        stem = cand.split(":")[0] + ":"
        hit = next((m for m in installed if m.startswith(stem)), None)
        if hit:
            return hit
    return preferred or DEFAULT_MODEL


def ensure_model(host: str, model: str = DEFAULT_MODEL) -> dict[str, Any]:
    installed = list_installed(host)
    pick = pick_installed_model(installed, model)
    if pick in installed or any(m.startswith(model.split(":")[0] + ":") for m in installed):
        return {"ok": True, "pulled": False, "model": pick, "installed": installed, "message": f"On-node · {pick}"}

    with PULL_LOCK:
        if _pull_state.get("active") and _pull_state.get("model") == model:
            return {"ok": True, "pulling": True, "model": model, "installed": installed, "message": f"Pulling {model}…"}
        _pull_state.update({"active": True, "ok": None, "message": f"Pulling {model}…", "model": model})
        threading.Thread(target=_pull_worker, args=(host, model), daemon=True).start()
    return {"ok": True, "pulling": True, "model": model, "installed": installed, "message": f"Auto-pulling {model}"}


def local_status() -> dict[str, Any]:
    langs = languages_status()
    host = resolve_ollama_host()
    ready_langs = [x["id"] for x in langs if x["ready"]]
    if not host:
        return {
            "ok": False,
            "ready": False,
            "ollama": False,
            "host": None,
            "installed": [],
            "model": DEFAULT_MODEL,
            "preferred_model": DEFAULT_MODEL,
            "pull": dict(_pull_state),
            "install": dict(_install_state),
            "languages": langs,
            "ready_languages": ready_langs,
            "compilers": {x["id"]: x.get("bin") or "" for x in langs},
            "message": _install_state.get("message")
            if _install_state.get("active")
            else "Ollama not online — website will install it automatically",
            "scripts_ready": bool(ready_langs),
            "managed_bin": str(_managed_ollama_bin()) if _managed_ollama_bin().exists() else "",
        }
    installed = list_installed(host)
    active_model = pick_installed_model(installed, DEFAULT_MODEL)
    model_ready = bool(installed) and not _pull_state.get("active") and not _install_state.get("active")
    return {
        "ok": True,
        "ready": model_ready,
        "ollama": True,
        "host": host,
        "installed": installed,
        "model": active_model,
        "preferred_model": DEFAULT_MODEL,
        "pull": dict(_pull_state),
        "install": dict(_install_state),
        "languages": langs,
        "ready_languages": ready_langs,
        "compilers": {x["id"]: x.get("bin") or "" for x in langs},
        "message": (
            _install_state.get("message")
            if _install_state.get("active")
            else (
                _pull_state.get("message")
                if _pull_state.get("active")
                else (f"Local ready · {active_model}" if model_ready else f"Local online · pulling {DEFAULT_MODEL}")
            )
        ),
        "scripts_ready": bool(ready_langs),
        "managed_bin": str(_managed_ollama_bin()) if _managed_ollama_bin().exists() else "",
    }


def auto_setup(*, pull: bool = True, ensure_site: bool = True, install_ollama: bool = True) -> dict[str, Any]:
    """Zero-touch: install Ollama if needed, start it, pull model, ensure site compute."""
    steps: list[dict[str, Any]] = []
    install_res: dict[str, Any] = {"ok": True, "skipped": True}
    if install_ollama:
        install_res = ensure_ollama_installed()
        steps.append(
            {
                "id": "ollama",
                "ok": bool(install_res.get("ok")),
                "detail": install_res.get("message"),
                "installing": bool(install_res.get("installing")),
            }
        )
        # Brief wait if we just started serve
        if install_res.get("started") or install_res.get("already"):
            time.sleep(0.2)
        elif install_res.get("installing"):
            # Still downloading — return early with progress; client polls
            status = local_status()
            return {
                "ok": True,
                "auto": True,
                "status": status,
                "steps": steps,
                "install": install_res,
                "languages": status.get("languages") or [],
                "templates": {row["id"]: row["template"] for row in LANG_CATALOG},
                "message": install_res.get("message") or "Installing Ollama…",
            }

    status = local_status()
    steps.append({"id": "detect", "ok": bool(status.get("ollama")), "detail": status.get("message")})

    if status.get("ollama") and pull:
        pull_res = ensure_model(status["host"], DEFAULT_MODEL)
        steps.append({"id": "model", "ok": True, "detail": pull_res.get("message"), "pulling": pull_res.get("pulling"), "model": pull_res.get("model")})
        status = local_status()
    else:
        steps.append({"id": "model", "ok": False, "detail": "Waiting for Ollama"})

    site: dict[str, Any] = {"ok": False, "skipped": True}
    if ensure_site and status.get("ollama"):
        try:
            from network_hub import get_hub  # type: ignore

            site = get_hub().ensure_site_compute()
            steps.append({"id": "site_compute", "ok": bool(site.get("ok")), "detail": site.get("node_id") or site.get("error") or "ok"})
        except Exception as exc:  # noqa: BLE001
            site = {"ok": False, "error": str(exc)}
            steps.append({"id": "site_compute", "ok": False, "detail": str(exc)})

    status = local_status()
    return {
        "ok": True,
        "auto": True,
        "status": status,
        "steps": steps,
        "site": site,
        "install": install_res,
        "languages": status.get("languages") or [],
        "templates": {row["id"]: row["template"] for row in LANG_CATALOG},
        "message": status.get("message") or "Local bootstrap finished",
    }


def _parse_script_stdout(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {"ok": True, "output": "", "explain": "Script produced empty stdout.", "metrics": {}}
    candidates = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            candidates.append(line)
    if text.startswith("{") and text.endswith("}"):
        candidates.append(text)
    for blob in reversed(candidates):
        try:
            obj = json.loads(blob)
            if isinstance(obj, dict):
                out = obj.get("output")
                if out is None:
                    out = obj.get("result") or obj.get("text") or ""
                return {
                    "ok": bool(obj.get("ok", True)),
                    "output": out if isinstance(out, str) else json.dumps(out, ensure_ascii=False),
                    "explain": str(obj.get("explain") or obj.get("reason") or "Structured JSON stdout."),
                    "metrics": obj.get("metrics") if isinstance(obj.get("metrics"), dict) else {},
                    "raw": obj,
                }
        except json.JSONDecodeError:
            continue
    return {
        "ok": True,
        "output": text,
        "explain": "Plain-text stdout — passed through as output.",
        "metrics": {"bytes": len(text.encode("utf-8"))},
    }


def _norm_lang(lang: str) -> str:
    l = (lang or "").strip().lower()
    aliases = {
        "py": "python",
        "python3": "python",
        "js": "javascript",
        "node": "javascript",
        "nodejs": "javascript",
        "ts": "javascript",
        "typescript": "javascript",
        "rb": "ruby",
        "sh": "bash",
        "shell": "bash",
        "zsh": "bash",
        "c++": "cpp",
        "cplusplus": "cpp",
        "cxx": "cpp",
        "rs": "rust",
        "golang": "go",
        "r-lang": "r",
        "rscript": "r",
    }
    return aliases.get(l, l)


def _safe_lang(lang: str) -> str:
    l = _norm_lang(lang)
    if not any(x["id"] == l for x in LANG_CATALOG):
        raise ValueError(f"Unsupported language: {lang}. Supported: {', '.join(x['id'] for x in LANG_CATALOG)}")
    return l


def default_source(lang: str) -> str:
    l = _safe_lang(lang)
    for row in LANG_CATALOG:
        if row["id"] == l:
            return row["template"]
    return PY_TEMPLATE


def run_script(
    *,
    lang: str,
    source: str,
    upstream: str = "",
    meta: dict | None = None,
    timeout: float = SCRIPT_TIMEOUT_SEC,
) -> dict[str, Any]:
    language = _safe_lang(lang)
    src = source or default_source(language)
    if len(src.encode("utf-8")) > MAX_SOURCE_BYTES:
        return {"ok": False, "message": f"Source too large (max {MAX_SOURCE_BYTES} bytes)"}

    banned = [
        r"\bos\.system\b",
        r"\bsubprocess\b",
        r"\bsocket\b",
        r"\burllib\b",
        r"\brequests\b",
        r"\bctypes\b",
        r"\bchild_process\b",
        r"\bRequire\s+['\"]net['\"]",
        r"\bsystem\s*\(",
        r"\bexec[lv]",
        r"\bpopen\s*\(",
        r"`[^`]*rm\s+-rf",
    ]
    for pat in banned:
        if re.search(pat, src, flags=re.I):
            return {"ok": False, "message": f"Blocked for safety: {pat} — keep scripts pure / local I/O only."}

    tool = resolve_tool(language)
    if not tool.get("ready"):
        return {
            "ok": False,
            "message": f"{language} runtime not found on this machine",
            "explain": f"Install a toolchain for {language}, or pick another language from the Scripts menu.",
            "lang": language,
        }

    row = next(x for x in LANG_CATALOG if x["id"] == language)
    input_text = (upstream or "")[:MAX_INPUT_CHARS]
    payload = {"input": input_text, "upstream": input_text, "meta": meta or {}}
    stdin_bytes = (
        json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if row.get("json_stdin", True)
        else input_text.encode("utf-8")
    )

    t0 = time.perf_counter()
    work = Path(tempfile.mkdtemp(prefix="noeti_canvas_"))
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/local/bin"),
        "HOME": str(work),
        "TMPDIR": str(work),
        "PYTHONDONTWRITEBYTECODE": "1",
        "LANG": "C.UTF-8",
    }
    # Keep cargo/go caches usable for compile langs
    for key in ("CARGO_HOME", "RUSTUP_HOME", "GOPATH", "JAVA_HOME"):
        if os.environ.get(key):
            env[key] = os.environ[key]

    try:
        ext = row["ext"]
        src_path = work / f"snap{ext}"
        if language == "java":
            src_path = work / "Main.java"
        src_path.write_text(src, encoding="utf-8")

        if language == "python":
            cmd = [tool["bin"], str(src_path)]
        elif language == "javascript":
            cmd = [tool["bin"], str(src_path)]
        elif language == "ruby":
            cmd = [tool["bin"], str(src_path)]
        elif language == "perl":
            cmd = [tool["bin"], str(src_path)]
        elif language == "bash":
            cmd = [tool["bin"], str(src_path)]
        elif language == "php":
            cmd = [tool["bin"], str(src_path)]
        elif language == "lua":
            cmd = [tool["bin"], str(src_path)]
        elif language == "r":
            cmd = [tool["bin"], str(src_path)]
        elif language in ("c", "cpp"):
            bin_path = work / "snap"
            compiler = tool["bin"]
            compile_cmd = [compiler, "-O1", str(src_path), "-o", str(bin_path)]
            if language == "cpp":
                compile_cmd[1:1] = ["-std=c++17"]
            else:
                compile_cmd[1:1] = ["-std=c11"]
            cproc = subprocess.run(compile_cmd, capture_output=True, timeout=min(timeout, 20), cwd=str(work), env=env)
            if cproc.returncode != 0:
                err = (cproc.stderr or cproc.stdout or b"").decode("utf-8", errors="replace")
                return {"ok": False, "message": f"{language} compile failed", "explain": err[:4000], "lang": language,
                        "latency_ms": int((time.perf_counter() - t0) * 1000)}
            cmd = [str(bin_path)]
        elif language == "rust":
            bin_path = work / "snap"
            cproc = subprocess.run(
                [tool["bin"], str(src_path), "-O", "-o", str(bin_path)],
                capture_output=True,
                timeout=min(timeout, 45),
                cwd=str(work),
                env=env,
            )
            if cproc.returncode != 0:
                err = (cproc.stderr or cproc.stdout or b"").decode("utf-8", errors="replace")
                return {"ok": False, "message": "Rust compile failed", "explain": err[:4000], "lang": language,
                        "latency_ms": int((time.perf_counter() - t0) * 1000)}
            cmd = [str(bin_path)]
        elif language == "go":
            bin_path = work / "snap"
            cproc = subprocess.run(
                [tool["bin"], "build", "-o", str(bin_path), str(src_path)],
                capture_output=True,
                timeout=min(timeout, 45),
                cwd=str(work),
                env=env,
            )
            if cproc.returncode != 0:
                err = (cproc.stderr or cproc.stdout or b"").decode("utf-8", errors="replace")
                return {"ok": False, "message": "Go build failed", "explain": err[:4000], "lang": language,
                        "latency_ms": int((time.perf_counter() - t0) * 1000)}
            cmd = [str(bin_path)]
        elif language == "java":
            cproc = subprocess.run(
                [tool["bin"], str(src_path)],
                capture_output=True,
                timeout=min(timeout, 30),
                cwd=str(work),
                env=env,
            )
            if cproc.returncode != 0:
                err = (cproc.stderr or cproc.stdout or b"").decode("utf-8", errors="replace")
                return {"ok": False, "message": "Java compile failed", "explain": err[:4000], "lang": language,
                        "latency_ms": int((time.perf_counter() - t0) * 1000)}
            java_bin = tool.get("java") or _which_any("java")
            cmd = [java_bin, "-cp", str(work), "Main"]
        else:
            return {"ok": False, "message": f"No runner wired for {language}"}

        proc = subprocess.run(
            cmd,
            input=stdin_bytes,
            capture_output=True,
            timeout=timeout,
            cwd=str(work),
            env=env,
        )
        stdout = (proc.stdout or b"").decode("utf-8", errors="replace")
        stderr = (proc.stderr or b"").decode("utf-8", errors="replace")
        parsed = _parse_script_stdout(stdout)
        latency = int((time.perf_counter() - t0) * 1000)
        if proc.returncode != 0 and not parsed.get("output"):
            return {
                "ok": False,
                "message": f"Script exit {proc.returncode}",
                "explain": (stderr or stdout or "non-zero exit")[:4000],
                "stderr": stderr[:4000],
                "stdout": stdout[:4000],
                "latency_ms": latency,
                "lang": language,
            }
        return {
            "ok": bool(parsed.get("ok", True)) and proc.returncode == 0,
            "output": parsed.get("output") or "",
            "explain": parsed.get("explain") or "",
            "metrics": parsed.get("metrics") or {},
            "stderr": stderr[:2000] if stderr else "",
            "latency_ms": latency,
            "lang": language,
            "message": "ok" if proc.returncode == 0 else f"exit {proc.returncode}",
            "where": f"Local · {language}",
            "route": "local",
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": f"Timed out after {timeout}s", "latency_ms": int((time.perf_counter() - t0) * 1000), "lang": language}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": str(exc), "latency_ms": int((time.perf_counter() - t0) * 1000), "lang": language}
    finally:
        shutil.rmtree(work, ignore_errors=True)


# Back-compat aliases used by older code
def PY_TEMPLATE_GET() -> str:
    return PY_TEMPLATE
