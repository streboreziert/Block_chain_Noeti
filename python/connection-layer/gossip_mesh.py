"""TCP gossip mesh — peer discovery and block propagation."""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable

MESH_PORT = int(os.environ.get("MESH_PORT", "5053"))
MESH_TTL = 90.0
PROTOCOL_VERSION = 2
SERVICE_TYPE = "_noetis-gossip._tcp.local."

_mesh: "GossipMesh | None" = None
_mdns: threading.Thread | None = None


# Task gossip types (aligned with mesh / observer visibility path)
TASK_OFFER = "TASK_OFFER"
TASK_CLAIM = "TASK_CLAIM"
TASK_RESULT = "TASK_RESULT"
TASK_FINALIZED = "TASK_FINALIZED"
TASK_MSG_TYPES = {TASK_OFFER, TASK_CLAIM, TASK_RESULT, TASK_FINALIZED}


class GossipMesh:
    def __init__(self, on_message: Callable[[dict[str, Any], tuple[str, int]], None] | None = None) -> None:
        self.on_message = on_message
        self._peers: dict[str, float] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._server: threading.Thread | None = None
        self._announcer: threading.Thread | None = None
        self.node_id = socket.gethostname()[:24]
        self._task_messages: list[dict[str, Any]] = []
        self._task_offer_count = 0
        self._task_claim_count = 0
        self._task_result_count = 0
        self._task_finalized_count = 0
        self._last_task_offer: dict[str, Any] | None = None
        # Local mailbox of open TASK_OFFERs (mesh-first claim path).
        self._pending_offers: dict[str, dict[str, Any]] = {}
        # task_id → list of remote TASK_RESULT attestations (mesh consensus path)
        self._peer_task_results: dict[str, list[dict[str, Any]]] = {}

    def start(self) -> None:
        if self._server and self._server.is_alive():
            return

        def _serve() -> None:
            server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("0.0.0.0", MESH_PORT))
            server.listen(32)
            server.settimeout(1.0)
            while not self._stop.is_set():
                try:
                    conn, addr = server.accept()
                    threading.Thread(
                        target=self._handle_client,
                        args=(conn, addr),
                        daemon=True,
                    ).start()
                except socket.timeout:
                    continue
                except OSError:
                    break
            server.close()

        def _announce() -> None:
            while not self._stop.wait(20.0):
                self.broadcast(
                    {
                        "type": "HELLO",
                        "protocol": PROTOCOL_VERSION,
                        "node_id": self.node_id,
                        "mesh_port": MESH_PORT,
                        "peers": self.peers()[:20],
                    }
                )
                self.broadcast({"type": "PEER_EXCHANGE", "peers": self.peers()[:50]})

        self._server = threading.Thread(target=_serve, daemon=True, name="gossip-serve")
        self._announcer = threading.Thread(target=_announce, daemon=True, name="gossip-announce")
        self._server.start()
        self._announcer.start()
        self._start_mdns()

    def _start_mdns(self) -> None:
        if os.environ.get("MDNS_DISCOVERY", "1") != "1":
            return

        def _run() -> None:
            try:
                from zeroconf import IPVersion, ServiceInfo, Zeroconf

                local_ip = socket.gethostbyname(socket.gethostname())
                info = ServiceInfo(
                    SERVICE_TYPE,
                    f"{self.node_id}.{SERVICE_TYPE}",
                    addresses=[socket.inet_aton(local_ip)],
                    port=MESH_PORT,
                    properties={"node_id": self.node_id.encode()},
                )
                zc = Zeroconf(ipversion=IPVersion.V4Only)
                zc.register_service(info)

                class Listener:
                    def add_service(inner_self, zc, type_, name) -> None:
                        data = zc.get_service_info(type_, name)
                        if data and data.addresses:
                            host = socket.inet_ntoa(data.addresses[0])
                            peer = f"{host}:{data.port}"
                            with self._lock:
                                self._peers[peer] = time.time()

                    def remove_service(inner_self, zc, type_, name) -> None:
                        pass

                    def update_service(inner_self, zc, type_, name) -> None:
                        pass

                from zeroconf import ServiceBrowser

                ServiceBrowser(zc, SERVICE_TYPE, Listener())
                while not self._stop.wait(30.0):
                    pass
                zc.unregister_service(info)
                zc.close()
            except Exception:
                pass

        global _mdns
        _mdns = threading.Thread(target=_run, daemon=True, name="gossip-mdns")
        _mdns.start()

    def stop(self) -> None:
        self._stop.set()

    def _handle_client(self, conn: socket.socket, addr: tuple[str, int]) -> None:
        try:
            conn.settimeout(5.0)
            buffer = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line:
                        continue
                    message = json.loads(line.decode("utf-8"))
                    self._ingest(message, addr)
                    if self.on_message:
                        self.on_message(message, addr)
        except Exception:
            pass
        finally:
            conn.close()

    def _ingest(self, message: dict[str, Any], addr: tuple[str, int]) -> None:
        msg_type = message.get("type")
        if msg_type == "HELLO":
            peer = f"{addr[0]}:{message.get('mesh_port', MESH_PORT)}"
            with self._lock:
                self._peers[peer] = time.time()
        elif msg_type == "PEER_EXCHANGE" or (msg_type == "HELLO" and message.get("peers")):
            now = time.time()
            with self._lock:
                for peer in message.get("peers") or []:
                    self._peers[str(peer)] = now
        elif msg_type in TASK_MSG_TYPES:
            if msg_type == TASK_OFFER:
                self.note_remote_offer(message)
            elif msg_type in {TASK_CLAIM, TASK_RESULT, TASK_FINALIZED}:
                self.clear_offer(str(message.get("task_id", "")).strip())
            if msg_type == TASK_RESULT:
                self.note_peer_task_result(message, source=f"{addr[0]}:{addr[1]}")
            self._record_task_message(message, source=f"{addr[0]}:{addr[1]}")
        elif msg_type == "HEADER_SYNC":
            pass

    def _record_task_message(self, message: dict[str, Any], *, source: str = "local") -> None:
        msg_type = str(message.get("type") or "")
        entry = {
            "ts": time.time(),
            "type": msg_type,
            "task_id": message.get("task_id"),
            "node_id": message.get("node_id") or message.get("origin"),
            "source": source,
            "payload": {
                k: message.get(k)
                for k in (
                    "task_id",
                    "prompt_hash",
                    "model",
                    "runtime",
                    "created_at",
                    "origin",
                    "node_id",
                    "response_hash",
                    "winner",
                    "workers_responded",
                    "workers_matched",
                    "consensus_hash",
                )
                if message.get(k) not in (None, "")
            },
        }
        with self._lock:
            self._task_messages.append(entry)
            self._task_messages[:] = self._task_messages[-100:]
            if msg_type == TASK_OFFER:
                self._task_offer_count += 1
                self._last_task_offer = entry
            elif msg_type == TASK_CLAIM:
                self._task_claim_count += 1
            elif msg_type == TASK_RESULT:
                self._task_result_count += 1
            elif msg_type == TASK_FINALIZED:
                self._task_finalized_count += 1

    def gossip_task_offer(
        self,
        *,
        task_id: str,
        prompt_hash: str,
        runtime: str = "ollama",
        model: str = "",
        origin: str = "",
        created_at: float | None = None,
        tier: str = "",
        preferred_model: str = "",
        tokens_est: int = 0,
        complexity: int = 0,
    ) -> None:
        message = {
            "type": TASK_OFFER,
            "task_id": task_id,
            "prompt_hash": prompt_hash,
            "runtime": runtime,
            "model": model,
            "created_at": created_at if created_at is not None else time.time(),
            "origin": origin or self.node_id,
            "tier": tier,
            "preferred_model": preferred_model,
            "tokens_est": tokens_est,
            "complexity": complexity,
        }
        with self._lock:
            self._pending_offers[task_id] = dict(message)
        self._record_task_message(message, source="local")
        try:
            self.broadcast(message)
        except Exception:
            pass

    def gossip_task_claim(self, *, task_id: str, node_id: str, runtime: str = "ollama") -> None:
        message = {
            "type": TASK_CLAIM,
            "task_id": task_id,
            "node_id": node_id,
            "runtime": runtime,
        }
        self.clear_offer(task_id)
        self._record_task_message(message, source="local")
        try:
            self.broadcast(message)
        except Exception:
            pass

    def gossip_task_result(
        self,
        *,
        task_id: str,
        node_id: str,
        response_hash: str,
        model: str = "",
    ) -> None:
        message = {
            "type": TASK_RESULT,
            "task_id": task_id,
            "node_id": node_id,
            "response_hash": response_hash,
            "model": model,
        }
        self.clear_offer(task_id)
        self._record_task_message(message, source="local")
        try:
            self.broadcast(message)
        except Exception:
            pass

    def note_peer_task_result(self, message: dict[str, Any], *, source: str = "remote") -> None:
        task_id = str(message.get("task_id", "")).strip()
        if not task_id:
            return
        entry = {
            "task_id": task_id,
            "node_id": message.get("node_id"),
            "response_hash": message.get("response_hash"),
            "model": message.get("model"),
            "source": source,
            "ts": time.time(),
        }
        with self._lock:
            rows = self._peer_task_results.setdefault(task_id, [])
            rows.append(entry)
            self._peer_task_results[task_id] = rows[-20:]
            if len(self._peer_task_results) > 200:
                # Drop oldest task ids
                for key in list(self._peer_task_results.keys())[:50]:
                    self._peer_task_results.pop(key, None)

    def peer_task_results(self, task_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._peer_task_results.get(task_id, []))

    def has_peer_task_result(self, task_id: str, *, response_hash: str = "") -> bool:
        rows = self.peer_task_results(task_id)
        if not rows:
            return False
        if not response_hash:
            return True
        return any(str(row.get("response_hash") or "") == response_hash for row in rows)

    def gossip_task_finalized(
        self,
        *,
        task_id: str,
        winner: str = "",
        consensus_hash: str = "",
        workers_responded: int = 0,
        workers_matched: int = 0,
        mode: str = "",
    ) -> None:
        message = {
            "type": TASK_FINALIZED,
            "task_id": task_id,
            "winner": winner,
            "consensus_hash": consensus_hash,
            "workers_responded": workers_responded,
            "workers_matched": workers_matched,
            "mode": mode,
            "origin": self.node_id,
        }
        self.clear_offer(task_id)
        with self._lock:
            self._peer_task_results.pop(task_id, None)
        self._record_task_message(message, source="local")
        try:
            self.broadcast(message)
        except Exception:
            pass

    def open_offers(self, *, runtime: str | None = None) -> list[dict[str, Any]]:
        """Return pending TASK_OFFER mailbox entries (mesh-first claim)."""
        with self._lock:
            rows = list(self._pending_offers.values())
        if runtime:
            rt = runtime.strip().lower()
            rows = [row for row in rows if str(row.get("runtime", "ollama")).lower() == rt]
        rows.sort(key=lambda row: float(row.get("created_at") or 0))
        return rows

    def clear_offer(self, task_id: str) -> None:
        with self._lock:
            self._pending_offers.pop(task_id, None)

    def note_remote_offer(self, message: dict[str, Any]) -> None:
        task_id = str(message.get("task_id", "")).strip()
        if not task_id:
            return
        with self._lock:
            self._pending_offers[task_id] = dict(message)

    def peers(self) -> list[str]:
        now = time.time()
        with self._lock:
            alive = [peer for peer, seen in self._peers.items() if now - seen <= MESH_TTL]
            self._peers = {peer: self._peers[peer] for peer in alive}
            return list(alive)

    def add_federation_peers(self, hub_urls: list[str]) -> None:
        for url in hub_urls:
            peer = resolve_mesh_peer(url)
            if not peer:
                continue
            with self._lock:
                self._peers[peer] = time.time()

    def broadcast(self, message: dict[str, Any]) -> None:
        payload = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        targets = set(self.peers())
        for peer in targets:
            self._send_to(peer, payload)

    def _send_to(self, peer: str, payload: bytes) -> None:
        try:
            host, port_str = peer.rsplit(":", 1)
            conn = socket.create_connection((host, int(port_str)), timeout=3.0)
            conn.sendall(payload)
            conn.close()
        except OSError:
            pass

    def announce_block(self, block: dict[str, Any]) -> None:
        header = {
            "index": block.get("index"),
            "hash": block.get("hash"),
            "previous_hash": block.get("previous_hash"),
            "state_root": (block.get("proof") or {}).get("state_root"),
        }
        self.broadcast({"type": "BLOCK_ANNOUNCE", "header": header, "block": block})

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            recent = list(self._task_messages[-20:])
            offers = self._task_offer_count
            claims = self._task_claim_count
            results = self._task_result_count
            finalized = self._task_finalized_count
            last_offer = self._last_task_offer
            pending = list(self._pending_offers.values())
        return {
            "mesh_port": MESH_PORT,
            "protocol": PROTOCOL_VERSION,
            "mdns": os.environ.get("MDNS_DISCOVERY", "1") == "1",
            "node_id": self.node_id,
            "peers": self.peers(),
            "task_gossip": {
                "offers": offers,
                "claims": claims,
                "results": results,
                "finalized": finalized,
                "recent": recent,
                "last_offer": last_offer,
                "pending_offers": pending,
            },
        }


def _handle_gossip(message: dict[str, Any], addr: tuple[str, int]) -> None:
    if message.get("type") != "BLOCK_ANNOUNCE":
        return
    block = message.get("block")
    if not isinstance(block, dict):
        return
    try:
        from inference_chain import get_chain

        local = get_chain()
        if block.get("index") != len(local.chain):
            return
        if block.get("previous_hash") != local.last_block.hash:
            return
        payload = [item.to_dict() for item in local.chain] + [block]
        local.merge_chain(payload)
    except Exception:
        pass


def get_mesh() -> GossipMesh:
    global _mesh
    if _mesh is None:
        _mesh = GossipMesh(on_message=_handle_gossip)
        _mesh.start()
    return _mesh


def start_mesh_with_federation(hub_urls: list[str]) -> GossipMesh:
    mesh = get_mesh()
    mesh.add_federation_peers(hub_urls)
    return mesh


def hub_hostname(hub_url: str) -> str:
    host = hub_url.replace("https://", "").replace("http://", "").split("/")[0]
    if ":" in host:
        return host.split(":", 1)[0]
    return host


def resolve_mesh_peer(hub_url: str) -> str | None:
    url = hub_url.strip().rstrip("/")
    if not url:
        return None
    hostname = hub_hostname(url)
    mesh_port = MESH_PORT
    try:
        request = urllib.request.Request(f"{url}/api/mesh")
        with urllib.request.urlopen(request, timeout=5.0) as response:
            data = json.loads(response.read().decode("utf-8"))
            mesh_port = int(data.get("mesh_port", MESH_PORT))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, ValueError):
        pass
    return f"{hostname}:{mesh_port}"
