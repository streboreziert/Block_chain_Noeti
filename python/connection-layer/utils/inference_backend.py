"""Inference backends — Ollama (production) or simulated (demo without Ollama)."""

from __future__ import annotations

import hashlib
import random
import time
from dataclasses import dataclass

from utils.ollama_client import NOETI_SYSTEM_PREAMBLE, OllamaClient, OllamaError, InferenceResult


@dataclass
class BackendInfo:
    mode: str
    model: str
    detail: str


class SimulatedBackend:
    """Deterministic local responses for demo when Ollama is unavailable."""

    def __init__(self, worker_id: str, model: str = "simulated-llm") -> None:
        self.worker_id = worker_id
        self.model = model

    def generate(self, prompt: str) -> InferenceResult:
        # Small delay so parallel workers are visible in the UI
        time.sleep(0.4 + random.uniform(0.2, 1.2))
        digest = hashlib.sha256(f"{self.worker_id}:{prompt}".encode()).hexdigest()[:8]
        response = (
            f"Decentralized inference processes prompts on independent worker nodes. "
            f"(worker {self.worker_id}, ref {digest})"
        )
        return InferenceResult(
            response=response,
            inference_ms=0.0,
            model=self.model,
        )


def create_backend(
    worker_id: str,
    model: str = "llama3.2:1b",
    ollama_url: str = "http://127.0.0.1:11434",
) -> tuple[object, BackendInfo]:
    client = OllamaClient(base_url=ollama_url, model=model)
    if client.is_available():
        resolved = client.resolve_model([model, "llama3.2:1b", "qwen2.5:0.5b"])
        return client, BackendInfo(
            mode="ollama",
            model=resolved,
            detail=f"Real Ollama inference ({resolved})",
        )

    simulated = SimulatedBackend(worker_id, model="simulated-local")
    return simulated, BackendInfo(
        mode="simulated",
        model="simulated-local",
        detail="Ollama not found — using simulated inference so the socket network still runs. Install Ollama for real LLM output.",
    )


def run_inference(backend: object, prompt: str) -> InferenceResult:
    if isinstance(backend, OllamaClient):
        started = time.perf_counter()
        result = backend.generate(prompt, system=NOETI_SYSTEM_PREAMBLE)
        result.inference_ms = (time.perf_counter() - started) * 1000
        return result
    return backend.generate(prompt)
