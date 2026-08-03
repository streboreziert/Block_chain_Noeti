"""Reward calculation for decentralized inference workers.

Modular design: swap this module later for on-chain token economics.
"""

from __future__ import annotations

from models.task import TaskResult


def calculate_rewards(
    results: list[TaskResult],
    consensus_response: str,
    *,
    base_reward: float = 10.0,
    normalize,
) -> list[TaskResult]:
    """Assign rewards to workers whose output matches the consensus response.

    Faster successful workers receive larger rewards (speed-weighted split).
  """
    if not results or not consensus_response:
        return results

    target = normalize(consensus_response)
    matched = [item for item in results if normalize(item.response) == target]
    if not matched:
        return results

    # Speed score: inverse latency (avoid division by zero)
    scores = [1.0 / max(item.inference_ms, 1.0) for item in matched]
    total_score = sum(scores)

    for item in results:
        if normalize(item.response) != target:
            item.matched_consensus = False
            item.reward = 0.0
            continue

        item.matched_consensus = True
        share = (1.0 / max(item.inference_ms, 1.0)) / total_score
        item.reward = round(base_reward * share, 4)

    return results


def pick_consensus(responses: list[str], *, normalize) -> str:
    """Majority vote on normalized responses. Tie-breaker: shortest latency order upstream."""
    if not responses:
        return ""

    buckets: dict[str, list[str]] = {}
    for text in responses:
        key = normalize(text)
        buckets.setdefault(key, []).append(text)

    winner_key = max(buckets, key=lambda key: len(buckets[key]))
    # Return the first original phrasing for that bucket
    return buckets[winner_key][0]


def pick_consensus_hash(results: list[TaskResult]) -> str:
    """Majority vote on response hashes (hub-blind interim). Returns winning hash."""
    if not results:
        return ""
    buckets: dict[str, list[TaskResult]] = {}
    for item in results:
        key = (item.response_hash or "").strip()
        if not key:
            continue
        buckets.setdefault(key, []).append(item)
    if not buckets:
        return ""
    return max(buckets, key=lambda key: len(buckets[key]))
