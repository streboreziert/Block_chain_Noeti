#!/usr/bin/env python3
"""Split a token job across N nodes. Same rule as noeti-split."""
from __future__ import annotations

import argparse
import json


def split(tokens: int, nodes: int, ms_per_1k: float = 10.0, slack: float = 0.15) -> dict:
    tokens = max(0, int(tokens))
    nodes = max(1, int(nodes))
    base, rem = divmod(tokens, nodes)
    plan = []
    for i in range(nodes):
        t = base + (rem if i == 0 else 0)
        plan.append({"node": i, "tokens": t, "est_ms": (t / 1000) * ms_per_1k})
    makespan = max(p["est_ms"] for p in plan) * (1 + slack)
    return {"job": "split", "plan": plan, "makespan_ms": makespan}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--tokens", type=int, default=48000)
    p.add_argument("--nodes", type=int, default=4)
    a = p.parse_args()
    print(json.dumps(split(a.tokens, a.nodes), indent=2))


if __name__ == "__main__":
    main()
