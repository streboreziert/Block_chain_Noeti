"""Ollama HTTP client for local LLM inference."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"

NOETI_SYSTEM_PREAMBLE = (
    "You are Noeti, a helpful, accurate AI assistant on the Noeti Compute Lab network. "
    "When the user message includes a [time context] section, treat those lines as ground "
    "truth for the current date and time. "
    "When the user message includes a [web context] section with real facts (not a "
    "'No live results retrieved' notice), base factual answers ONLY on that web context. "
    "Do NOT use memorized sports facts that contradict the web context. "
    "Never invent host countries, team counts, tournament dates, or match results. "
    "If [web context] says no live results were retrieved, is empty, or is missing for a "
    "live/current-events or sports question, say you do not have verified live data — "
    "do NOT guess hosts, dates, team counts, or scores from training memory, and do not "
    "tell the user to check an external website instead of answering from available context. "
    "Be clear and complete. If unsure, say so."
)


class OllamaError(RuntimeError):
    pass


# Deterministic decoding — every node must produce identical output for the same
# prompt + model, so consensus compares like with like.
# num_predict must match Rust (noetis-network ollama.rs) for consensus.
DETERMINISTIC_SEED = 42
DETERMINISTIC_OPTIONS = {
    "temperature": 0.0,
    "seed": DETERMINISTIC_SEED,
    "top_k": 1,
    "num_predict": 1024,
}


@dataclass
class InferenceResult:
    response: str
    inference_ms: float
    model: str
    seed: int = DETERMINISTIC_SEED
    prompt_eval_count: int | None = None
    eval_count: int | None = None


class OllamaClient:
    def __init__(
        self,
        base_url: str | None = None,
        model: str = "llama3.2:1b",
        timeout: float = 120.0,
    ) -> None:
        if not base_url:
            base_url = os.environ.get("OLLAMA_HOST", DEFAULT_OLLAMA_HOST)
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def is_available(self) -> bool:
        try:
            self._request("GET", "/api/tags")
            return True
        except OllamaError:
            return False

    def list_models(self) -> list[str]:
        data = self._request("GET", "/api/tags")
        models = data.get("models", [])
        return [item.get("name", "") for item in models if item.get("name")]

    def resolve_model(self, preferred: list[str] | None = None) -> str:
        available = self.list_models()
        if not available:
            raise OllamaError(
                "No Ollama models found. Install Ollama and run: ollama pull llama3.2:1b"
            )

        candidates = preferred or [self.model, "llama3.2:1b", "qwen2.5:0.5b", "phi3:mini"]
        for name in candidates:
            if name in available:
                self.model = name
                return name
            for installed in available:
                if installed.startswith(name.split(":")[0]):
                    self.model = installed
                    return installed

        self.model = available[0]
        return available[0]

    def generate(
        self,
        prompt: str,
        *,
        system: str | None = None,
        num_predict: int | None = None,
    ) -> InferenceResult:
        options = dict(DETERMINISTIC_OPTIONS)
        if num_predict is not None:
            try:
                n = int(num_predict)
                if 128 <= n <= 2048:
                    options["num_predict"] = n
            except (TypeError, ValueError):
                pass
        payload: dict = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": options,
        }
        if system:
            payload["system"] = system

        started = time.perf_counter()
        data = self._request("POST", "/api/generate", payload)
        elapsed_ms = (time.perf_counter() - started) * 1000

        response = str(data.get("response", "")).strip()
        if not response:
            raise OllamaError("Ollama returned an empty response")

        prompt_eval = data.get("prompt_eval_count")
        eval_count = data.get("eval_count")
        return InferenceResult(
            response=response,
            inference_ms=elapsed_ms,
            model=str(data.get("model") or self.model),
            seed=DETERMINISTIC_SEED,
            prompt_eval_count=int(prompt_eval) if prompt_eval is not None else None,
            eval_count=int(eval_count) if eval_count is not None else None,
        )

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = f"{self.base_url}{path}"
        headers = {"Content-Type": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise OllamaError(f"Ollama HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise OllamaError(
                "Cannot reach Ollama at "
                f"{self.base_url}. Install and start Ollama: https://ollama.com"
            ) from exc
