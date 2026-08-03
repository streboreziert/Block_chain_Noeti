#!/usr/bin/env python3
"""Custom AI workflow generator for Noeti Canvas.

Turns a plain-language brief into a placeable board graph.
Uses a fast heuristic composer, optionally refined by the local model.
"""

from __future__ import annotations

import json
import re
from typing import Any

ALLOWED_TYPES = {
    "note",
    "prompt",
    "system",
    "model",
    "vision",
    "phone",
    "calc",
    "atomize",
    "code",
    "script",
    "output",
    "checker",
    "validator",
    "watcher",
    "witness",
    "gate",
}

GEN_SYSTEM = """You design Noeti Canvas workflow graphs.
Reply with ONLY valid JSON (no markdown) shaped like:
{"title":"...","nodes":[{"id":"n1","type":"prompt","x":80,"y":200,"data":{"text":"..."}}],"edges":[{"from":"n1","to":"n2","rel":"related"}]}
Rules:
- Use only these types: note, prompt, system, model, vision, phone, calc, atomize, code, script, output, checker, validator, watcher, witness, gate
- Keep 4–10 nodes. Space x by ~360, y by ~280.
- Always include one prompt and one output.
- For code/math, include a script node with data.lang (python|javascript|c|…).
- For journalism/claims, include atomize + checker/validator/watcher + gate.
- Notes are short sticky tips (yellow cards).
- Edges must reference node ids. rel is related|supports|contests.
"""


def _nid(i: int) -> str:
    return f"g{i}"


def heuristic_graph(brief: str) -> dict[str, Any]:
    text = (brief or "").strip() or "Build a simple AI workflow"
    low = text.lower()
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    i = 1
    CX, RY = 360, 280

    def add(typ: str, x: int, y: int, data: dict | None = None) -> str:
        nonlocal i
        nid = _nid(i)
        i += 1
        nodes.append({"id": nid, "type": typ, "x": x, "y": y, "data": data or {}})
        return nid

    def wire(a: str, b: str, rel: str = "related") -> None:
        edges.append({"from": a, "to": b, "rel": rel})

    title = text[:72]
    tip = add(
        "note",
        40,
        40,
        {
            "text": f"1 · Your workflow\n{title}\n\n2 · Wire blocks out → in\n3 · Press ▶ Run\n4 · Edit any block in Inspect"
        },
    )
    tips = add(
        "note",
        40 + CX * 3,
        40,
        {
            "text": "A few tips…\n• ⌘Z undo\n• Scripts menu → any language\n• Setup installs local compute for you\n• Seal when the gate is ready"
        },
    )
    void = (tip, tips)

    wants_script = bool(re.search(r"\b(script|code|python|javascript|rust|c\+\+|golang|bash|calc|math|sum|numbers?)\b", low))
    wants_vision = bool(re.search(r"\b(vision|image|photo|ocr|camera|picture)\b", low))
    wants_news = bool(re.search(r"\b(news|journalis|desk|claim|source|fact.?check|publish|article|report)\b", low))
    wants_private = bool(re.search(r"\b(private|secret|confidential|on.?node|local only)\b", low))
    wants_phone = bool(re.search(r"\b(phone|mobile|handset)\b", low))
    route = "private" if wants_private else "local"

    p = add("prompt", 80, 220, {"text": text, "route": route, "output": text})
    prev = p

    if wants_phone:
        ph = add("phone", 80 + CX, 220, {"route": "phone", "phone": "phone-mira"})
        wire(prev, ph)
        prev = ph

    if wants_vision:
        vis = add(
            "vision",
            80 + CX,
            220 + (RY if wants_phone else 0),
            {"text": "Describe what is visible. Flag soft claims.", "route": route},
        )
        wire(prev, vis)
        prev = vis
        calc = add("calc", 80 + CX * 2, 220, {"route": "local"})
        wire(prev, calc)
        prev = calc
    elif wants_news:
        m = add("model", 80 + CX, 220, {"route": route, "text": "Draft a careful desk summary. Prefer UNKNOWN."})
        wire(prev, m)
        a = add("atomize", 80 + CX * 2, 220, {"route": route})
        wire(m, a)
        c = add("checker", 80 + CX * 2, 220 + RY, {"route": route})
        v = add("validator", 80 + CX * 3, 220, {"route": route})
        w = add("watcher", 80 + CX * 3, 220 + RY, {"route": route})
        wire(a, c, "related")
        wire(a, v, "related")
        wire(a, w, "contests")
        g = add("gate", 80 + CX * 4, 220 + RY // 2, {"route": route})
        wire(c, g, "supports")
        wire(v, g, "related")
        wire(w, g, "contests")
        prev = g
    elif wants_script:
        lang = "python"
        if "javascript" in low or "node" in low:
            lang = "javascript"
        elif re.search(r"\bc\+\+|cpp\b", low):
            lang = "cpp"
        elif re.search(r"\brust\b", low):
            lang = "rust"
        elif re.search(r"\b(go|golang)\b", low):
            lang = "go"
        elif re.search(r"\bc\b", low) and "javascript" not in low:
            lang = "c"
        elif "ruby" in low:
            lang = "ruby"
        elif "bash" in low or "shell" in low:
            lang = "bash"
        m = add("model", 80 + CX, 180, {"route": route, "text": "Extract the numbers and context for a deterministic check."})
        wire(prev, m)
        s = add("script", 80 + CX, 180 + RY, {"route": "local", "lang": lang})
        wire(prev, s)
        g = add("gate", 80 + CX * 2, 180 + RY // 2, {"route": "local"})
        wire(m, g, "related")
        wire(s, g, "supports")
        prev = g
    else:
        m = add("model", 80 + CX, 220, {"route": route, "text": "Do the task carefully. Be concise."})
        wire(prev, m)
        g = add("gate", 80 + CX * 2, 220, {"route": route})
        wire(m, g)
        prev = g

    out = add("output", 80 + CX * (4 if wants_news else 3), 220, {"route": route})
    wire(prev, out)
    _ = void

    return {
        "ok": True,
        "title": title,
        "mode": "heuristic",
        "nodes": nodes,
        "edges": edges,
        "cam": {"x": 40, "y": 20, "z": 0.62},
        "note": "Generated locally from your brief · edit freely",
    }


def _sanitize(graph: dict[str, Any], fallback_brief: str) -> dict[str, Any]:
    nodes_in = graph.get("nodes") if isinstance(graph, dict) else None
    if not isinstance(nodes_in, list) or len(nodes_in) < 2:
        return heuristic_graph(fallback_brief)

    nodes: list[dict[str, Any]] = []
    id_map: dict[str, str] = {}
    for idx, raw in enumerate(nodes_in[:14]):
        if not isinstance(raw, dict):
            continue
        typ = str(raw.get("type") or "note").strip().lower()
        if typ not in ALLOWED_TYPES:
            continue
        old = str(raw.get("id") or f"n{idx}")
        new = f"g{idx + 1}"
        id_map[old] = new
        data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
        clean_data = {k: v for k, v in data.items() if isinstance(k, str) and k[:40]}
        if typ == "script" and "lang" not in clean_data:
            clean_data["lang"] = "python"
        nodes.append(
            {
                "id": new,
                "type": typ,
                "x": int(raw.get("x") or (80 + (idx % 4) * 360)),
                "y": int(raw.get("y") or (200 + (idx // 4) * 280)),
                "data": clean_data,
            }
        )

    if len(nodes) < 2:
        return heuristic_graph(fallback_brief)

    edges: list[dict[str, Any]] = []
    for raw in (graph.get("edges") or [])[:24]:
        if not isinstance(raw, dict):
            continue
        a = id_map.get(str(raw.get("from") or ""))
        b = id_map.get(str(raw.get("to") or ""))
        if not a or not b or a == b:
            continue
        rel = str(raw.get("rel") or "related")
        if rel not in ("related", "supports", "contests"):
            rel = "related"
        edges.append({"from": a, "to": b, "rel": rel})

    if not edges and len(nodes) >= 2:
        for i in range(len(nodes) - 1):
            edges.append({"from": nodes[i]["id"], "to": nodes[i + 1]["id"], "rel": "related"})

    return {
        "ok": True,
        "title": str(graph.get("title") or fallback_brief)[:80],
        "mode": "model",
        "nodes": nodes,
        "edges": edges,
        "cam": {"x": 40, "y": 20, "z": 0.6},
        "note": "Generated with local model · edit freely",
    }


def _extract_json(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if fence:
        raw = fence.group(1).strip()
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(raw[start : end + 1])
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def generate_workflow(brief: str, *, use_model: bool = True) -> dict[str, Any]:
    base = heuristic_graph(brief)
    if not use_model:
        return base

    try:
        from golem_chat import chat as golem_chat
    except Exception:
        return base

    try:
        result = golem_chat(
            [
                {"role": "system", "content": GEN_SYSTEM},
                {
                    "role": "user",
                    "content": f"Build a canvas workflow for:\n{brief.strip()[:1200]}\n\nReturn JSON only.",
                },
            ],
            prefer_local=True,
            temperature=0.2,
        )
        if not result.get("ok"):
            return base
        parsed = _extract_json(result.get("reply") or result.get("message") or "")
        if not parsed:
            return base
        out = _sanitize(parsed, brief)
        out["model_used"] = result.get("model") or ""
        return out
    except Exception as exc:  # noqa: BLE001
        base["note"] = f"Heuristic graph (model refine skipped: {exc})"
        return base
