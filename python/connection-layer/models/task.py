"""Data models for inference tasks and worker responses."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class WorkerInfo:
    worker_id: str
    model: str
    address: str = ""


@dataclass
class TaskResult:
    task_id: str
    worker_id: str
    prompt: str
    response: str
    inference_ms: float
    model: str
    matched_consensus: bool = False
    reward: float = 0.0
    response_hash: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "worker_id": self.worker_id,
            "prompt": self.prompt,
            "response": self.response,
            "response_hash": self.response_hash,
            "inference_ms": round(self.inference_ms, 1),
            "model": self.model,
            "matched_consensus": self.matched_consensus,
            "reward": round(self.reward, 4),
        }


@dataclass
class TaskSummary:
    task_id: str
    prompt: str
    consensus_response: str
    results: list[TaskResult] = field(default_factory=list)
    workers_responded: int = 0
    workers_matched: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "prompt": self.prompt,
            "consensus_response": self.consensus_response,
            "workers_responded": self.workers_responded,
            "workers_matched": self.workers_matched,
            "results": [item.to_dict() for item in self.results],
        }
