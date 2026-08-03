"""Decentralized AI network — parallel local inference, consensus, on-chain settlement."""

from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from inference_chain import finalize_on_chain, get_chain
from mlc import get_balances, wallet_address
from models.task import TaskResult, TaskSummary
from reward import calculate_rewards, pick_consensus
from utils.ollama_client import NOETI_SYSTEM_PREAMBLE, OllamaClient, OllamaError
from utils.protocol import normalize_response

DEFAULT_MODEL = "qwen2.5:0.5b"
DEFAULT_NODES = 3


@dataclass
class NetworkEvent:
    timestamp: float
    kind: str
    message: str
    node_id: str | None = None
    task_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "time": datetime.fromtimestamp(self.timestamp).strftime("%H:%M:%S"),
            "kind": self.kind,
            "message": self.message,
            "node_id": self.node_id,
            "task_id": self.task_id,
        }


@dataclass
class InferenceNode:
    node_id: str
    model: str
    status: str = "online"
    last_action: str = "Ready"
    address: str = ""

    def __post_init__(self) -> None:
        self.address = wallet_address(self.node_id)


class DecentralizedNetwork:
    def __init__(self, node_count: int = DEFAULT_NODES, model: str = DEFAULT_MODEL) -> None:
        self.node_count = max(1, min(node_count, 6))
        self.model = model
        self._ollama = OllamaClient(model=model)
        self._nodes: list[InferenceNode] = [
            InferenceNode(node_id=f"node-{index:02d}", model=model)
            for index in range(1, self.node_count + 1)
        ]
        self._events: list[NetworkEvent] = []
        self._events_lock = threading.Lock()
        self._task_lock = threading.Lock()
        self._stats: list[TaskSummary] = []
        self.running_task: str | None = None
        self.last_error: str | None = None
        self._resolved_model: str | None = None

    def _log(self, kind: str, message: str, *, node_id: str | None = None, task_id: str | None = None) -> None:
        with self._events_lock:
            self._events.append(
                NetworkEvent(time.time(), kind, message, node_id=node_id, task_id=task_id)
            )
            self._events[:] = self._events[-200:]

    def bootstrap(self) -> dict[str, Any]:
        if not self._ollama.is_available():
            self.last_error = (
                "Ollama is not running. Install from https://ollama.com then run: ollama serve"
            )
            self._log("error", self.last_error)
            return {"ok": False, "error": self.last_error}

        try:
            self._resolved_model = self._ollama.resolve_model(
                [self.model, "qwen2.5:0.5b", "llama3.2:1b", "phi3:mini"]
            )
        except OllamaError as exc:
            self.last_error = str(exc)
            self._log("error", self.last_error)
            return {"ok": False, "error": self.last_error}

        for node in self._nodes:
            node.model = self._resolved_model
            node.status = "online"
            node.last_action = f"Running {self._resolved_model}"

        self.last_error = None
        self._log("network", f"Decentralized AI online — {len(self._nodes)} nodes · {self._resolved_model}")
        return {"ok": True, "model": self._resolved_model, "nodes": len(self._nodes)}

    def _run_node(self, node: InferenceNode, task_id: str, prompt: str) -> TaskResult:
        node.status = "inferring"
        node.last_action = "Running inference"
        self._log("infer", f"{node.node_id} processing prompt", node_id=node.node_id, task_id=task_id)

        client = OllamaClient(model=node.model)
        started = time.perf_counter()
        result = client.generate(prompt, system=NOETI_SYSTEM_PREAMBLE)
        elapsed = (time.perf_counter() - started) * 1000

        node.status = "online"
        node.last_action = f"Completed in {elapsed:.0f}ms"

        return TaskResult(
            task_id=task_id,
            worker_id=node.node_id,
            prompt=prompt,
            response=result.response,
            inference_ms=elapsed,
            model=result.model,
        )

    def infer(self, prompt: str) -> TaskSummary:
        prompt = prompt.strip()
        if not prompt:
            raise ValueError("Prompt required")

        if self.running_task:
            raise RuntimeError("Inference already in progress")

        boot = self.bootstrap()
        if not boot.get("ok"):
            raise RuntimeError(boot.get("error", "Network unavailable"))

        task_id = uuid.uuid4().hex[:12]
        with self._task_lock:
            self.running_task = task_id
            self.last_error = None

        self._log("task", f"Dispatching to {len(self._nodes)} nodes", task_id=task_id)

        results: list[TaskResult] = []
        try:
            with ThreadPoolExecutor(max_workers=len(self._nodes)) as pool:
                futures = {
                    pool.submit(self._run_node, node, task_id, prompt): node for node in self._nodes
                }
                for future in as_completed(futures):
                    results.append(future.result())
        except OllamaError as exc:
            self.last_error = str(exc)
            self._log("error", self.last_error, task_id=task_id)
            raise RuntimeError(self.last_error) from exc
        finally:
            with self._task_lock:
                self.running_task = None

        if not results:
            raise RuntimeError("No inference results received")

        consensus = pick_consensus(
            [item.response for item in results],
            normalize=normalize_response,
        )
        self._log("consensus", "Majority consensus reached", task_id=task_id)

        results = calculate_rewards(
            results,
            consensus,
            base_reward=10.0,
            normalize=normalize_response,
        )

        summary = TaskSummary(
            task_id=task_id,
            prompt=prompt,
            consensus_response=consensus,
            results=results,
            workers_responded=len(results),
            workers_matched=sum(1 for item in results if item.matched_consensus),
        )
        self._stats.append(summary)

        block = finalize_on_chain(summary)
        self._log(
            "block",
            f"Block #{block.index} committed — {block.proof.get('mlc_distributed', 0)} MLC",
            task_id=task_id,
        )
        return summary

    def snapshot(self) -> dict[str, Any]:
        balances = {row["worker_id"]: row["balance"] for row in get_balances()}
        chain = get_chain().snapshot()
        with self._events_lock:
            events = [event.to_dict() for event in self._events[-100:]]

        nodes = [
            {
                "node_id": node.node_id,
                "worker_id": node.node_id,
                "model": node.model,
                "address": node.address,
                "mlc_address": node.address,
                "mlc_balance": balances.get(node.node_id, 0.0),
                "status": node.status,
                "last_action": node.last_action,
            }
            for node in self._nodes
        ]

        ollama_ok = self._ollama.is_available()
        return {
            "mode": "decentralized_ai",
            "ollama_available": ollama_ok,
            "ollama_model": self._resolved_model,
            "node_count": len(nodes),
            "worker_count": len(nodes),
            "nodes": nodes,
            "workers": nodes,
            "events": events,
            "running_task": self.running_task,
            "dispatch_error": self.last_error,
            "last_task": self._stats[-1].to_dict() if self._stats else None,
            "task_count": len(self._stats),
            "blockchain": chain,
            "mlc_supply_distributed": round(sum(b.get("balance", 0) for b in get_balances()), 4),
            "architecture": {
                "layers": [
                    {"name": "User", "role": "Submits prompts to the decentralized mesh"},
                    {"name": "Inference nodes", "role": "Parallel local LLM execution via Ollama"},
                    {"name": "Consensus", "role": "Majority vote verifies AI outputs"},
                    {"name": "Blockchain", "role": "Proof-of-Inference chain with SHA-256 links"},
                    {"name": "MLC", "role": "Settlement layer for verified compute"},
                ],
                "consensus": "Majority vote on inference outputs",
                "proof_type": "proof_of_inference",
                "token": "MLC",
            },
        }


_network = DecentralizedNetwork()
_network.bootstrap()


def get_network() -> DecentralizedNetwork:
    return _network
