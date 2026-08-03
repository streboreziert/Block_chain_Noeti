#!/usr/bin/env python3
"""Coordinator — task routing, verification, and rewards for decentralized inference."""

from __future__ import annotations

import argparse
import socket
import socketserver
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from models.task import TaskResult, TaskSummary
from reward import calculate_rewards, pick_consensus
from utils.ollama_client import OllamaClient
from utils.protocol import normalize_response, read_message, send_message

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9600
TASK_TIMEOUT = 180.0
EventCallback = Callable[[str, str, str | None, str | None], None]


@dataclass
class NetworkEvent:
    timestamp: float
    kind: str
    message: str
    worker_id: str | None = None
    task_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "time": datetime.fromtimestamp(self.timestamp).strftime("%H:%M:%S"),
            "kind": self.kind,
            "message": self.message,
            "worker_id": self.worker_id,
            "task_id": self.task_id,
        }


@dataclass
class WorkerState:
    worker_id: str
    model: str
    address: str
    status: str = "online"
    last_action: str = "Connected"
    total_rewards: float = 0.0
    tasks_completed: int = 0


@dataclass
class WorkerConnection:
    worker_id: str
    model: str
    conn: socket.socket
    address: str
    buffer: bytearray = field(default_factory=bytearray)


class TaskCollector:
    def __init__(self, task_id: str, prompt: str, timeout: float) -> None:
        self.task_id = task_id
        self.prompt = prompt
        self.timeout = timeout
        self.results: list[TaskResult] = []
        self._lock = threading.Lock()
        self._done = threading.Event()

    def add(self, result: TaskResult) -> None:
        with self._lock:
            if result.task_id != self.task_id:
                return
            if any(item.worker_id == result.worker_id for item in self.results):
                return
            self.results.append(result)

    def wait(self, expected: int) -> list[TaskResult]:
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            with self._lock:
                if len(self.results) >= expected:
                    return list(self.results)
            time.sleep(0.05)
        with self._lock:
            return list(self.results)


class Coordinator:
    def __init__(
        self,
        host: str,
        port: int,
        base_reward: float = 10.0,
        on_event: EventCallback | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.base_reward = base_reward
        self.on_event = on_event
        self.workers: dict[str, WorkerConnection] = {}
        self.worker_states: dict[str, WorkerState] = {}
        self._workers_lock = threading.Lock()
        self._task_lock = threading.Lock()
        self._active_collector: TaskCollector | None = None
        self._active_task_id: str | None = None
        self._stats: list[TaskSummary] = []
        self.events: list[NetworkEvent] = []
        self._events_lock = threading.Lock()
        self.running_task: str | None = None
        self._dispatch_error: str | None = None

    def _log(
        self,
        kind: str,
        message: str,
        worker_id: str | None = None,
        task_id: str | None = None,
    ) -> None:
        event = NetworkEvent(time.time(), kind, message, worker_id, task_id)
        with self._events_lock:
            self.events.append(event)
            self.events = self.events[-300:]
        if self.on_event:
            self.on_event(kind, message, worker_id, task_id)
        print(f"[coordinator] {message}")

    def register_worker(self, connection: WorkerConnection) -> None:
        with self._workers_lock:
            self.workers[connection.worker_id] = connection
            self.worker_states[connection.worker_id] = WorkerState(
                worker_id=connection.worker_id,
                model=connection.model,
                address=connection.address,
                status="online",
                last_action="Socket registered",
            )
        self._log(
            "socket",
            f"Worker {connection.worker_id} connected via TCP ({connection.model})",
            worker_id=connection.worker_id,
        )

    def unregister_worker(self, worker_id: str) -> None:
        with self._workers_lock:
            self.workers.pop(worker_id, None)
            self.worker_states.pop(worker_id, None)
        self._log("socket", f"Worker {worker_id} disconnected", worker_id=worker_id)

    def worker_count(self) -> int:
        with self._workers_lock:
            return len(self.workers)

    def submit_result(self, result: TaskResult) -> None:
        collector = self._active_collector
        if collector is not None:
            collector.add(result)

        with self._workers_lock:
            state = self.worker_states.get(result.worker_id)
            if state:
                state.status = "online"
                state.tasks_completed += 1
                state.last_action = f"Inference done ({result.inference_ms:.0f}ms)"

        self._log(
            "result",
            f"{result.worker_id} returned inference in {result.inference_ms:.0f}ms",
            worker_id=result.worker_id,
            task_id=result.task_id,
        )

    def run_dispatch(self, prompt: str) -> None:
        try:
            self.dispatch_task(prompt)
        except Exception as exc:
            self._dispatch_error = str(exc)
        finally:
            if self._active_task_id is None:
                self.running_task = None

    def dispatch_task(self, prompt: str) -> TaskSummary:
        self._dispatch_error = None
        with self._workers_lock:
            workers = list(self.workers.values())

        if not workers:
            raise RuntimeError("No workers connected. Start worker.py processes first.")

        task_id = uuid.uuid4().hex[:12]
        collector = TaskCollector(task_id, prompt, TASK_TIMEOUT)

        with self._task_lock:
            self._active_collector = collector
            self._active_task_id = task_id
            self.running_task = task_id

        self._log("task", f"Client prompt received: {prompt[:120]}", task_id=task_id)
        self._log(
            "task",
            f"Dispatching task {task_id} to {len(workers)} workers over TCP sockets",
            task_id=task_id,
        )

        with self._workers_lock:
            for worker in workers:
                state = self.worker_states.get(worker.worker_id)
                if state:
                    state.status = "inferring"
                    state.last_action = "Running Ollama inference"
                self._log(
                    "socket",
                    f"TCP → {worker.worker_id}: {{op: task, task_id: {task_id}}}",
                    worker_id=worker.worker_id,
                    task_id=task_id,
                )

        for worker in workers:
            send_message(worker.conn, {"op": "task", "task_id": task_id, "prompt": prompt})

        results = collector.wait(expected=len(workers))
        with self._task_lock:
            self._active_collector = None
            self._active_task_id = None
            self.running_task = None

        if not results:
            raise RuntimeError("No worker responses received before timeout")

        consensus = pick_consensus(
            [item.response for item in results],
            normalize=normalize_response,
        )
        self._log(
            "consensus",
            f"Majority consensus selected ({len(results)} responses)",
            task_id=task_id,
        )

        results = calculate_rewards(
            results,
            consensus,
            base_reward=self.base_reward,
            normalize=normalize_response,
        )

        for item in results:
            with self._workers_lock:
                state = self.worker_states.get(item.worker_id)
                if state and item.matched_consensus:
                    state.total_rewards += item.reward
                    state.last_action = f"Reward +{item.reward:.4f}"
            if item.matched_consensus:
                self._log(
                    "reward",
                    f"{item.worker_id} earned {item.reward:.4f} (matched consensus)",
                    worker_id=item.worker_id,
                    task_id=task_id,
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
        self._print_task_log(summary)
        self._log("task", f"Task {task_id} complete", task_id=task_id)

        from inference_chain import finalize_on_chain

        block = finalize_on_chain(summary)
        self._log(
            "block",
            f"Block #{block.index} added — {block.proof.get('mlc_distributed', 0)} MLC distributed",
            task_id=task_id,
        )
        return summary

    def snapshot(self) -> dict[str, Any]:
        from inference_chain import get_chain
        from mlc import get_balances, wallet_address

        balances = {row["worker_id"]: row["balance"] for row in get_balances()}
        with self._workers_lock:
            workers = [
                {
                    "worker_id": state.worker_id,
                    "model": state.model,
                    "address": state.address,
                    "mlc_address": wallet_address(state.worker_id),
                    "mlc_balance": balances.get(state.worker_id, 0.0),
                    "status": state.status,
                    "last_action": state.last_action,
                    "total_rewards": round(state.total_rewards, 4),
                    "tasks_completed": state.tasks_completed,
                }
                for state in self.worker_states.values()
            ]
        with self._events_lock:
            events = [event.to_dict() for event in self.events[-100:]]
        last_task = self._stats[-1].to_dict() if self._stats else None
        chain = get_chain().snapshot()
        return {
            "coordinator": f"{self.host}:{self.port}",
            "worker_count": len(workers),
            "workers": workers,
            "events": events,
            "running_task": self.running_task,
            "dispatch_error": self._dispatch_error,
            "last_task": last_task,
            "task_count": len(self._stats),
            "blockchain": chain,
            "mlc_supply_distributed": round(
                sum(b.get("balance", 0) for b in get_balances()), 4
            ),
        }

    def _print_task_log(self, summary: TaskSummary) -> None:
        print("\n" + "=" * 72)
        print(f"TASK {summary.task_id}")
        print("=" * 72)
        print(f"Prompt: {summary.prompt}")
        print(f"Consensus: {summary.consensus_response}")
        print("-" * 72)
        for item in sorted(summary.results, key=lambda row: row.inference_ms):
            status = "MATCH" if item.matched_consensus else "DIFF"
            print(
                f"worker={item.worker_id:<10} "
                f"time={item.inference_ms:>8.1f}ms "
                f"reward={item.reward:>7.4f} "
                f"status={status}"
            )
            print(f"  response: {item.response[:200]}{'...' if len(item.response) > 200 else ''}")
        print("-" * 72)
        total_reward = sum(item.reward for item in summary.results)
        print(
            f"workers responded: {summary.workers_responded} | "
            f"matched consensus: {summary.workers_matched} | "
            f"total rewards: {total_reward:.4f}"
        )
        print("=" * 72 + "\n")

    def handle_connection(self, conn: socket.socket, address: tuple[str, int]) -> None:
        buffer = bytearray()
        try:
            message, buffer = read_message(conn, buffer)
            op = message.get("op")

            if op == "register":
                self._handle_worker(conn, address, message, buffer)
                return

            if op == "prompt":
                self._handle_client(conn, message)
                return

            send_message(conn, {"op": "error", "message": f"Unknown op: {op}"})
        except (ConnectionError, OSError, ValueError) as exc:
            print(f"[coordinator] connection error from {address}: {exc}")
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _handle_worker(
        self,
        conn: socket.socket,
        address: tuple[str, int],
        register_message: dict,
        buffer: bytearray,
    ) -> None:
        worker_id = str(register_message.get("worker_id", "")).strip()
        model = str(register_message.get("model", "llama3.2:1b")).strip()
        if not worker_id:
            send_message(conn, {"op": "error", "message": "worker_id required"})
            conn.close()
            return

        connection = WorkerConnection(
            worker_id=worker_id,
            model=model,
            conn=conn,
            address=f"{address[0]}:{address[1]}",
            buffer=buffer,
        )
        self.register_worker(connection)
        from mlc import ensure_wallet

        wallet = ensure_wallet(worker_id)
        with self._workers_lock:
            state = self.worker_states.get(worker_id)
            if state:
                state.last_action = f"Wallet {wallet['address']}"
        send_message(conn, {"op": "registered", "worker_id": worker_id, "mlc_address": wallet["address"]})

        try:
            while True:
                message, connection.buffer = read_message(conn, connection.buffer)
                if message.get("op") != "result":
                    continue

                result = TaskResult(
                    task_id=str(message.get("task_id", "")),
                    worker_id=worker_id,
                    prompt="",
                    response=str(message.get("response", "")),
                    inference_ms=float(message.get("inference_ms", 0.0)),
                    model=str(message.get("model", model)),
                )
                self.submit_result(result)
        except (ConnectionError, OSError, ValueError):
            pass
        finally:
            self.unregister_worker(worker_id)
            try:
                conn.close()
            except OSError:
                pass

    def _handle_client(self, conn: socket.socket, message: dict) -> None:
        prompt = str(message.get("text", "")).strip()
        if not prompt:
            send_message(conn, {"op": "error", "message": "text required"})
            return

        try:
            summary = self.dispatch_task(prompt)
            send_message(conn, {"op": "task_complete", **summary.to_dict()})
        except RuntimeError as exc:
            send_message(conn, {"op": "error", "message": str(exc)})


class ThreadedServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    parser = argparse.ArgumentParser(description="Decentralized inference coordinator")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--reward", type=float, default=10.0, help="Base reward pool per task")
    args = parser.parse_args()

    ollama = OllamaClient()
    if not ollama.is_available():
        print("Warning: Ollama is not reachable. Workers need Ollama for inference.")
        print("Install: https://ollama.com  then: ollama pull llama3.2:1b")
    else:
        try:
            model = ollama.resolve_model()
            print(f"[coordinator] Ollama reachable. Suggested model: {model}")
        except Exception as exc:
            print(f"[coordinator] Ollama warning: {exc}")

    coordinator = Coordinator(args.host, args.port, base_reward=args.reward)

    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            coordinator.handle_connection(self.request, self.client_address)

    server = ThreadedServer((args.host, args.port), Handler)
    print(f"[coordinator] listening on {args.host}:{args.port}")
    print("[coordinator] waiting for workers and client prompts")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[coordinator] shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
