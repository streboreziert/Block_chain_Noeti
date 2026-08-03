"""ProofPath run packets: auditable export, integrity digest, persisted runs."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from pathlib import Path
from threading import Lock
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "connection-layer" / "data"
RUNS_PATH = DATA_DIR / "proofpath_runs.json"
_lock = Lock()

METHOD = [
    "search_or_private",
    "atomize",
    "sourcing_graph",
    "multi_witness_judges",
    "publish_gate",
    "integrity_digest",
]

# Models at or below this param class are draft-grade for publish claims.
_DRAFT_MARKERS = ("0.5b", "1.5b", "1b", "3b", "tiny", "mini")


def _ensure() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def _write(path: Path, data: Any) -> None:
    _ensure()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def new_run_id() -> str:
    return f"pp_{int(time.time())}_{secrets.token_hex(4)}"


def classify_quality(models: list[str], *, private: bool = False) -> dict[str, Any]:
    """Honest quality floor for current demo compute."""
    blob = " ".join(m.lower() for m in models if m)
    draftish = not models or any(m in blob for m in _DRAFT_MARKERS)
    if private and draftish:
        tier = "private_draft"
        label = "Private draft — local only, not publish-ready"
    elif draftish:
        tier = "draft"
        label = "Draft grade — small models; treat gate as triage, not publish-ready"
    else:
        tier = "review_grade"
        label = "Review grade — stronger panel; human editor still required"
    return {
        "tier": tier,
        "label": label,
        "publish_ready": False,  # never auto-claim publish-ready on current fleet
        "models": sorted(set(models)),
    }


def _canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def integrity_digest(body: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(_canonical(body).encode("utf-8")).hexdigest()


def build_packet(workflow: dict[str, Any], *, private: bool = False, run_id: str | None = None) -> dict[str, Any]:
    """Build a shareable ProofPath trail from a newsroom workflow result."""
    rid = run_id or new_run_id()
    models = [workflow.get("worker_model") or ""]
    for row in workflow.get("judgements") or []:
        for j in row.get("judges") or []:
            if j.get("model"):
                models.append(j["model"])

    quality = classify_quality(models, private=private)
    gate = (workflow.get("summary") or {}).get("publish_gate") or "review"
    # Honest override: draft fleets never surface as "ready to publish"
    display_gate = gate
    if quality["tier"] in ("draft", "private_draft") and gate == "ready":
        display_gate = "review"
        quality = {
            **quality,
            "label": quality["label"] + " · gate softened to review",
            "gate_softened": True,
        }

    audit = []
    for row in workflow.get("activity") or []:
        audit.append(
            {
                "stage": row.get("stage"),
                "actor": row.get("actor"),
                "model": row.get("model"),
                "role": row.get("role"),
                "did": row.get("did"),
                "verdict": row.get("verdict"),
                "reason": row.get("reason"),
                "claim": row.get("claim"),
                "latency_ms": row.get("latency_ms"),
                "saw": row.get("saw"),
            }
        )

    claims_out = []
    for row in workflow.get("judgements") or []:
        judges = []
        for j in row.get("judges") or []:
            judges.append(
                {
                    "model": j.get("model"),
                    "role": j.get("role"),
                    "label": j.get("label"),
                    "verdict": j.get("verdict"),
                    "reason": j.get("reason"),
                    "latency_ms": j.get("latency_ms"),
                    "ok": j.get("ok"),
                    "saw": j.get("saw")
                    or {
                        "source_count": len(workflow.get("sources") or []),
                        "source_urls": [s.get("url") for s in (workflow.get("sources") or [])[:6] if s.get("url")],
                    },
                }
            )
        claims_out.append(
            {
                "text": row.get("claim"),
                "aggregate": row.get("aggregate"),
                "witnesses": judges,
            }
        )

    core = {
        "product": "Noeti ProofPath",
        "run_id": rid,
        "created_at": time.time(),
        "query": workflow.get("query"),
        "routing": "private_local" if private else "public_search",
        "worker_model": workflow.get("worker_model"),
        "enabled_roles": workflow.get("enabled_roles") or [],
        "steps": workflow.get("steps") or [],
        "sources": workflow.get("sources") or [],
        "claims_raw": workflow.get("claims") or [],
        "graph": workflow.get("graph") or {},
        "claims": claims_out,
        "summary": {
            **(workflow.get("summary") or {}),
            "publish_gate": display_gate,
            "pipeline_gate": gate,
        },
        "quality": quality,
        "audit": audit,
        "method": METHOD,
        "note": workflow.get("note")
        or (
            "Private local path — no public search; do not treat as publish-ready."
            if private
            else "Public demo workflow — do not paste confidential sources."
        ),
        "latency_ms": workflow.get("latency_ms"),
    }
    digest_body = {
        "run_id": rid,
        "query": core["query"],
        "routing": core["routing"],
        "summary": core["summary"],
        "claims": core["claims"],
        "sources": [{"url": s.get("url"), "title": s.get("title")} for s in core["sources"]],
        "quality": core["quality"],
    }
    core["integrity"] = {
        "alg": "sha256",
        "digest": integrity_digest(digest_body),
        "signed": False,
        "signer": None,
        "message": "Integrity digest over claim/source/gate core. Cryptographic desk signing ships with Desk seats.",
    }
    core["share_path"] = f"/proof/{rid}"
    core["api_path"] = f"/api/proofpath/runs/{rid}"
    core["export_path"] = f"/api/proofpath/runs/{rid}/export"
    return core


def save_run(packet: dict[str, Any]) -> dict[str, Any]:
    rid = packet.get("run_id") or new_run_id()
    packet["run_id"] = rid
    with _lock:
        data = _read(RUNS_PATH, {"runs": {}})
        runs = data.setdefault("runs", {})
        runs[rid] = packet
        # Cap store to last 400 runs
        if len(runs) > 400:
            ordered = sorted(runs.items(), key=lambda kv: kv[1].get("created_at") or 0)
            for old_id, _ in ordered[: len(runs) - 400]:
                runs.pop(old_id, None)
        _write(RUNS_PATH, data)
    return packet


def get_run(run_id: str) -> dict[str, Any] | None:
    data = _read(RUNS_PATH, {"runs": {}})
    return (data.get("runs") or {}).get(run_id)


def list_runs(limit: int = 20) -> list[dict[str, Any]]:
    data = _read(RUNS_PATH, {"runs": {}})
    runs = list((data.get("runs") or {}).values())
    runs.sort(key=lambda r: r.get("created_at") or 0, reverse=True)
    out = []
    for r in runs[: max(1, min(limit, 100))]:
        out.append(
            {
                "run_id": r.get("run_id"),
                "created_at": r.get("created_at"),
                "query": (r.get("query") or "")[:160],
                "publish_gate": (r.get("summary") or {}).get("publish_gate"),
                "quality": (r.get("quality") or {}).get("tier"),
                "routing": r.get("routing"),
                "share_path": r.get("share_path"),
            }
        )
    return out


def export_run(run_id: str, fmt: str = "json") -> dict[str, Any]:
    packet = get_run(run_id)
    if not packet:
        return {"ok": False, "error": "not_found", "message": "ProofPath run not found"}

    trail = {
        "product": packet.get("product") or "Noeti ProofPath",
        "exported_at": time.time(),
        "run_id": packet.get("run_id"),
        "query": packet.get("query"),
        "routing": packet.get("routing"),
        "publish_gate": (packet.get("summary") or {}).get("publish_gate"),
        "pipeline_gate": (packet.get("summary") or {}).get("pipeline_gate"),
        "quality": packet.get("quality"),
        "integrity": packet.get("integrity"),
        "claims": packet.get("claims") or [],
        "sources": packet.get("sources") or [],
        "graph": packet.get("graph") or {},
        "audit": packet.get("audit") or [],
        "method": packet.get("method") or METHOD,
        "note": packet.get("note"),
    }

    if fmt == "json":
        return {"ok": True, "format": "json", "trail": trail}

    lines = [
        "NOETI PROOFPATH PACKET",
        f"Run: {trail['run_id']}",
        f"Query: {trail['query']}",
        f"Routing: {trail['routing']}",
        f"Gate: {trail['publish_gate']} (pipeline {trail.get('pipeline_gate')})",
        f"Quality: {(trail.get('quality') or {}).get('tier')} — {(trail.get('quality') or {}).get('label')}",
        f"Integrity: {(trail.get('integrity') or {}).get('digest')}",
        f"Exported: {time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime(trail['exported_at']))}",
        "",
        "CLAIMS",
    ]
    for i, c in enumerate(trail["claims"], 1):
        agg = c.get("aggregate") or {}
        lines.append(f"{i}. [{agg.get('final_verdict')}/{agg.get('publish_gate')}] {c.get('text')}")
        for w in c.get("witnesses") or []:
            lines.append(f"   · {w.get('label')} ({w.get('model')}): {w.get('verdict')} — {w.get('reason')}")
            saw = w.get("saw") or {}
            if saw.get("source_count") is not None:
                lines.append(f"     saw {saw.get('source_count')} source(s)")
        lines.append("")
    lines.append("SOURCES")
    for s in trail["sources"][:12]:
        lines.append(f"- {s.get('title')}: {s.get('url')}")
    lines.append("")
    lines.append("WHO DID WHAT")
    for a in trail["audit"][:40]:
        lines.append(f"- [{a.get('stage')}] {a.get('actor')}: {a.get('did')}")
    return {
        "ok": True,
        "format": "txt",
        "filename": f"proofpath-{run_id}.txt",
        "content": "\n".join(lines),
        "trail": trail,
    }


def attach_to_workflow(workflow: dict[str, Any], *, private: bool = False, persist: bool = True) -> dict[str, Any]:
    """Mutate workflow dict with proofpath packet + run_id."""
    if not workflow.get("ok"):
        return workflow
    packet = build_packet(workflow, private=private)
    if persist:
        save_run(packet)
    workflow["run_id"] = packet["run_id"]
    workflow["proofpath"] = packet
    # Soften summary gate for UI consistency
    if workflow.get("summary") and packet.get("summary"):
        workflow["summary"] = {**workflow["summary"], **packet["summary"]}
        workflow["summary"]["quality"] = packet.get("quality")
    return workflow
