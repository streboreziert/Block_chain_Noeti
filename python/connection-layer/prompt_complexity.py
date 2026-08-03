"""Prompt complexity scoring and model-tier routing helpers."""

from __future__ import annotations

import re
from typing import Any

TIER_ORDER = {"tiny": 0, "small": 1, "medium": 2, "large": 3}

TIER_MODELS: dict[str, list[str]] = {
    "tiny": ["qwen2.5:0.5b", "llama3.2:1b"],
    "small": ["qwen2.5:1.5b", "qwen2.5:3b", "phi3:mini"],
    # Prefer 7b/8b when available; 1.5b lets constrained site nodes still take medium work.
    "medium": ["qwen2.5:7b", "llama3.1:8b", "qwen2.5:1.5b"],
    "large": ["qwen2.5:14b", "qwen2.5:32b", "llama3.1:70b"],
}

_MULTI_STEP = re.compile(
    r"\b(explain|prove|implement|compare|analyze|derive|refactor|debug|design|step[- ]by[- ]step)\b",
    re.I,
)
_CODE_FENCE = re.compile(r"```")
_NON_ASCII = re.compile(r"[^\x00-\x7F]")


def estimate_tokens(prompt: str) -> int:
    text = prompt or ""
    by_chars = max(1, int(round(len(text) / 4)))
    by_words = max(1, len(text.split()))
    return max(by_chars, int(by_words * 1.3))


def tier_rank(tier: str) -> int:
    return TIER_ORDER.get((tier or "tiny").lower(), 0)


def complexity_to_tier(complexity: int) -> str:
    if complexity < 20:
        return "tiny"
    if complexity < 45:
        return "small"
    if complexity < 70:
        return "medium"
    return "large"


def score_prompt(prompt: str) -> dict[str, Any]:
    text = (prompt or "").strip()
    tokens_est = estimate_tokens(text)
    reasons: list[str] = []
    score = 0.0

    if tokens_est >= 800:
        score += 40
        reasons.append("long prompt")
    elif tokens_est >= 300:
        score += 28
        reasons.append("medium length")
    elif tokens_est >= 80:
        score += 14
        reasons.append("short-medium length")
    else:
        score += 4
        reasons.append("tiny length")

    fences = len(_CODE_FENCE.findall(text))
    if fences:
        score += min(25, 8 + fences * 4)
        reasons.append(f"code fences×{max(1, fences // 2)}")

    steps = _MULTI_STEP.findall(text)
    if steps:
        score += min(25, 6 * len({s.lower() for s in steps}))
        reasons.append("multi-step verbs")

    non_ascii = len(_NON_ASCII.findall(text))
    if non_ascii >= 12:
        score += 12
        reasons.append("language mix / non-ascii")
    elif non_ascii >= 3:
        score += 6
        reasons.append("some non-ascii")

    if "\n" in text and text.count("\n") >= 8:
        score += 8
        reasons.append("multi-paragraph")

    complexity = int(max(0, min(100, round(score))))
    tier = complexity_to_tier(complexity)
    preferred = preferred_models_for_tier(tier)
    return {
        "tokens_est": tokens_est,
        "complexity": complexity,
        "tier": tier,
        "reasons": reasons,
        "preferred_models": preferred,
    }


def model_tier(model: str | None) -> str:
    name = (model or "").lower()
    size_map = [
        (r"70b|65b|34b|32b|22b|13b|14b", "large"),
        (r"8b|7b|9b", "medium"),
        (r"3b|3\.8b|4b|phi-?3|phi3|mini|1\.5b|2b", "small"),
        (r"0\.5b|1b|tiny|270m|500m", "tiny"),
    ]
    for pattern, tier in size_map:
        if re.search(pattern, name):
            return tier
    if "large" in name:
        return "large"
    if "medium" in name:
        return "medium"
    if "small" in name or "mini" in name:
        return "small"
    return "tiny"


def preferred_models_for_tier(tier: str) -> list[str]:
    """Models for this tier first, then step down to smaller installed fallbacks."""
    t = (tier or "tiny").lower()
    if t not in TIER_MODELS:
        t = "tiny"
    rank = tier_rank(t)
    cascade = [k for k in ("large", "medium", "small", "tiny") if tier_rank(k) <= rank]
    cascade.sort(key=lambda k: -tier_rank(k))
    ordered: list[str] = []
    for key in cascade:
        for model in TIER_MODELS[key]:
            if model not in ordered:
                ordered.append(model)
    return ordered or list(TIER_MODELS["tiny"])


def resolve_model_for_tier(
    available: list[str],
    tier: str,
    *,
    fallback: str | None = None,
) -> str:
    """Pick best installed model for tier, falling down if not installed."""
    candidates = preferred_models_for_tier(tier)
    if fallback:
        candidates = candidates + [fallback]
    installed = list(available or [])
    target = tier_rank(tier)

    for name in candidates:
        if name in installed:
            return name
        for inst in installed:
            base = name.split(":")[0]
            if inst == name or inst.startswith(base):
                if tier_rank(model_tier(inst)) >= target or base in inst:
                    return inst

    if installed:
        ranked = sorted(
            installed,
            key=lambda m: (abs(tier_rank(model_tier(m)) - target), -tier_rank(model_tier(m))),
        )
        return ranked[0]
    return candidates[0] if candidates else (fallback or "qwen2.5:0.5b")
