#!/usr/bin/env python3
"""Extract app.rs paths / content from local git without checkout."""
import zlib
import struct
from pathlib import Path

repo = Path(__file__).resolve().parent
git = repo / ".git"
out = repo / "_app_rs_findings.txt"

lines = []

def read_obj(sha: str) -> bytes:
    sha = sha.strip()
    p = git / "objects" / sha[:2] / sha[2:]
    if p.exists():
        return zlib.decompress(p.read_bytes())
    # try packs
    pack_dir = git / "objects" / "pack"
    if not pack_dir.exists():
        raise FileNotFoundError(sha)
    for idx_path in pack_dir.glob("*.idx"):
        # minimal idx v2 parse for offset
        data = idx_path.read_bytes()
        if data[:4] != b"\xfftOc":
            continue
        version = struct.unpack(">I", data[4:8])[0]
        if version != 2:
            continue
        fanout = struct.unpack(">256I", data[8:8+1024])
        n = fanout[255]
        names = data[8+1024:8+1024+20*n]
        # crcs then offsets
        off_base = 8+1024+20*n+4*n
        offsets = data[off_base:off_base+4*n]
        # find sha
        target = bytes.fromhex(sha)
        lo, hi = (fanout[int(sha[:2], 16)-1] if int(sha[:2], 16) else 0), fanout[int(sha[:2], 16)]
        for i in range(lo, hi):
            if names[i*20:(i+1)*20] == target:
                offset = struct.unpack(">I", offsets[i*4:(i+1)*4])[0]
                if offset & 0x80000000:
                    # large offset table — skip for now
                    raise RuntimeError("large offset")
                pack = idx_path.with_suffix(".pack")
                return read_pack_obj(pack, offset)
    raise FileNotFoundError(sha)

def read_pack_obj(pack_path: Path, offset: int) -> bytes:
    data = pack_path.read_bytes()
    # skip header
    i = offset
    c = data[i]; i += 1
    typ = (c >> 4) & 7
    size = c & 15
    shift = 4
    while c & 0x80:
        c = data[i]; i += 1
        size |= (c & 0x7f) << shift
        shift += 7
    if typ == 6:  # OFS_DELTA
        raise RuntimeError("ofs delta at %d" % offset)
    if typ == 7:  # REF_DELTA
        raise RuntimeError("ref delta at %d" % offset)
    # zlib stream
    return b"%s %d\x00" % ({1:b"commit",2:b"tree",3:b"blob",4:b"tag"}[typ], size) + zlib.decompress(data[i:])

def parse_obj(raw: bytes):
    nul = raw.index(b"\x00")
    header = raw[:nul].decode()
    body = raw[nul+1:]
    kind, size_s = header.split(" ")
    return kind, body

def tree_entries(body: bytes):
    entries = []
    i = 0
    while i < len(body):
        sp = body.index(b" ", i)
        mode = body[i:sp].decode()
        nul = body.index(b"\x00", sp)
        name = body[sp+1:nul].decode()
        sha = body[nul+1:nul+21].hex()
        i = nul + 21
        entries.append((mode, name, sha))
    return entries

def walk(sha: str, prefix: str = ""):
    kind, body = parse_obj(read_obj(sha))
    if kind != "tree":
        return
    for mode, name, child in tree_entries(body):
        path = f"{prefix}{name}"
        if name == "app.rs" or path.endswith("/app.rs"):
            lines.append(f"FOUND {path} sha={child}")
            try:
                k, blob = parse_obj(read_obj(child))
                if k == "blob":
                    text = blob.decode("utf-8", errors="replace")
                    # dump status-related bits
                    dump = repo / "_app_rs_dump.txt"
                    if "local" in text.lower() or "desktop" in text.lower() or path.count("/") <= 4:
                        dump.write_text(text)
                        lines.append(f"WROTE {dump} ({len(text)} bytes) from {path}")
            except Exception as e:
                lines.append(f"read fail {path}: {e}")
        if mode.startswith("40") or mode == "040000":
            try:
                walk(child, path + "/")
            except Exception as e:
                lines.append(f"walk fail {path}: {e}")

# tip of rust branch
rust = (git / "refs/heads/rust").read_text().strip()
lines.append(f"rust tip {rust}")
kind, commit = parse_obj(read_obj(rust))
assert kind == "commit"
# tree line
tree_line = commit.split(b"\n")[0].decode()
tree = tree_line.split()[1]
lines.append(f"tree {tree}")
walk(tree)

out.write_text("\n".join(lines) + "\n")
print(out)
print("\n".join(lines[:50]))
