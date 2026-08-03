//! TCP gossip mesh — newline-delimited JSON, protocol-compatible with the
//! Python `gossip_mesh.py` (HELLO / PEER_EXCHANGE / BLOCK_ANNOUNCE /
//! TASK_OFFER / TASK_CLAIM / TASK_RESULT).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MESH_TTL: f64 = 90.0;
pub const PROTOCOL_VERSION: i64 = 2;

pub const TASK_OFFER: &str = "TASK_OFFER";
pub const TASK_CLAIM: &str = "TASK_CLAIM";
pub const TASK_RESULT: &str = "TASK_RESULT";
pub const TASK_FINALIZED: &str = "TASK_FINALIZED";

fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub type BlockHandler = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Default)]
struct TaskGossipStats {
    offers: u64,
    claims: u64,
    results: u64,
    finalized: u64,
    recent: Vec<Value>,
    last_offer: Option<Value>,
    pending_offers: HashMap<String, Value>,
}

pub struct GossipMesh {
    pub mesh_port: u16,
    pub node_id: String,
    peers: Arc<Mutex<HashMap<String, f64>>>,
    on_block: Arc<Mutex<Option<BlockHandler>>>,
    task_stats: Arc<Mutex<TaskGossipStats>>,
}

impl GossipMesh {
    pub fn new(mesh_port: u16) -> Arc<Self> {
        let node_id: String = hostname().chars().take(24).collect();
        let mesh = Arc::new(GossipMesh {
            mesh_port,
            node_id,
            peers: Arc::new(Mutex::new(HashMap::new())),
            on_block: Arc::new(Mutex::new(None)),
            task_stats: Arc::new(Mutex::new(TaskGossipStats::default())),
        });
        mesh.clone().start();
        mesh
    }

    pub fn set_block_handler(&self, handler: BlockHandler) {
        *self.on_block.lock().unwrap() = Some(handler);
    }

    fn start(self: Arc<Self>) {
        let server = self.clone();
        std::thread::spawn(move || server.serve());
        let announcer = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(20));
            let peers = announcer.peers_list();
            announcer.broadcast(&json!({
                "type": "HELLO",
                "protocol": PROTOCOL_VERSION,
                "node_id": announcer.node_id,
                "mesh_port": announcer.mesh_port,
                "peers": peers.iter().take(20).collect::<Vec<_>>(),
            }));
            announcer.broadcast(&json!({
                "type": "PEER_EXCHANGE",
                "peers": peers.iter().take(50).collect::<Vec<_>>(),
            }));
        });
    }

    fn serve(self: Arc<Self>) {
        let Ok(listener) = TcpListener::bind(("0.0.0.0", self.mesh_port)) else {
            return;
        };
        for stream in listener.incoming().flatten() {
            let mesh = self.clone();
            std::thread::spawn(move || mesh.handle_client(stream));
        }
    }

    fn handle_client(&self, stream: TcpStream) {
        let peer_ip = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let reader = BufReader::new(stream);
        for line in reader.lines().flatten() {
            if line.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            self.ingest(&message, &peer_ip);
        }
    }

    fn ingest(&self, message: &Value, peer_ip: &str) {
        match message.get("type").and_then(Value::as_str) {
            Some("HELLO") => {
                let port = message.get("mesh_port").and_then(Value::as_u64).unwrap_or(self.mesh_port as u64);
                self.add_peer(&format!("{peer_ip}:{port}"));
                for peer in message.get("peers").and_then(Value::as_array).cloned().unwrap_or_default() {
                    if let Some(p) = peer.as_str() {
                        self.add_peer(p);
                    }
                }
            }
            Some("PEER_EXCHANGE") => {
                for peer in message.get("peers").and_then(Value::as_array).cloned().unwrap_or_default() {
                    if let Some(p) = peer.as_str() {
                        self.add_peer(p);
                    }
                }
            }
            Some("BLOCK_ANNOUNCE") => {
                if let Some(block) = message.get("block").cloned() {
                    if let Some(handler) = self.on_block.lock().unwrap().as_ref() {
                        handler(block);
                    }
                }
            }
            Some(TASK_OFFER) | Some(TASK_CLAIM) | Some(TASK_RESULT) | Some(TASK_FINALIZED) => {
                self.record_task_message(message);
            }
            _ => {}
        }
    }

    fn record_task_message(&self, message: &Value) {
        let msg_type = message.get("type").and_then(Value::as_str).unwrap_or("");
        let entry = json!({
            "ts": now(),
            "type": msg_type,
            "task_id": message.get("task_id"),
            "node_id": message.get("node_id").or_else(|| message.get("origin")),
            "payload": message,
        });
        let mut stats = self.task_stats.lock().unwrap();
        match msg_type {
            TASK_OFFER => {
                stats.offers += 1;
                stats.last_offer = Some(entry.clone());
                if let Some(tid) = message.get("task_id").and_then(Value::as_str) {
                    stats.pending_offers.insert(tid.to_string(), message.clone());
                }
            }
            TASK_CLAIM => {
                stats.claims += 1;
                if let Some(tid) = message.get("task_id").and_then(Value::as_str) {
                    stats.pending_offers.remove(tid);
                }
            }
            TASK_RESULT => {
                stats.results += 1;
                if let Some(tid) = message.get("task_id").and_then(Value::as_str) {
                    stats.pending_offers.remove(tid);
                }
            }
            TASK_FINALIZED => {
                stats.finalized += 1;
                if let Some(tid) = message.get("task_id").and_then(Value::as_str) {
                    stats.pending_offers.remove(tid);
                }
            }
            _ => {}
        }
        stats.recent.push(entry);
        if stats.recent.len() > 100 {
            let drain = stats.recent.len() - 100;
            stats.recent.drain(0..drain);
        }
    }

    pub fn open_offers(&self, runtime: Option<&str>) -> Vec<Value> {
        let stats = self.task_stats.lock().unwrap();
        let mut rows: Vec<Value> = stats.pending_offers.values().cloned().collect();
        if let Some(rt) = runtime {
            let rt = rt.trim().to_lowercase();
            rows.retain(|row| {
                row.get("runtime")
                    .and_then(Value::as_str)
                    .unwrap_or("ollama")
                    .eq_ignore_ascii_case(&rt)
            });
        }
        rows.sort_by(|a, b| {
            let ca = a.get("created_at").and_then(Value::as_f64).unwrap_or(0.0);
            let cb = b.get("created_at").and_then(Value::as_f64).unwrap_or(0.0);
            ca.partial_cmp(&cb).unwrap_or(std::cmp::Ordering::Equal)
        });
        rows
    }

    pub fn clear_offer(&self, task_id: &str) {
        self.task_stats.lock().unwrap().pending_offers.remove(task_id);
    }

    pub fn gossip_task_offer(
        &self,
        task_id: &str,
        prompt_hash: &str,
        runtime: &str,
        model: &str,
        origin: &str,
        created_at: f64,
    ) {
        let origin_s = if origin.is_empty() {
            self.node_id.clone()
        } else {
            origin.to_string()
        };
        let message = json!({
            "type": TASK_OFFER,
            "task_id": task_id,
            "prompt_hash": prompt_hash,
            "runtime": runtime,
            "model": model,
            "created_at": created_at,
            "origin": origin_s,
        });
        self.record_task_message(&message);
        self.broadcast(&message);
    }

    pub fn gossip_task_claim(&self, task_id: &str, node_id: &str, runtime: &str) {
        let message = json!({
            "type": TASK_CLAIM,
            "task_id": task_id,
            "node_id": node_id,
            "runtime": runtime,
        });
        self.clear_offer(task_id);
        self.record_task_message(&message);
        self.broadcast(&message);
    }

    pub fn gossip_task_result(&self, task_id: &str, node_id: &str, response_hash: &str, model: &str) {
        let message = json!({
            "type": TASK_RESULT,
            "task_id": task_id,
            "node_id": node_id,
            "response_hash": response_hash,
            "model": model,
        });
        self.clear_offer(task_id);
        self.record_task_message(&message);
        self.broadcast(&message);
    }

    pub fn gossip_task_finalized(
        &self,
        task_id: &str,
        winner: &str,
        consensus_hash: &str,
        workers_responded: i64,
        workers_matched: i64,
    ) {
        let message = json!({
            "type": TASK_FINALIZED,
            "task_id": task_id,
            "winner": winner,
            "consensus_hash": consensus_hash,
            "workers_responded": workers_responded,
            "workers_matched": workers_matched,
            "origin": self.node_id,
        });
        self.clear_offer(task_id);
        self.record_task_message(&message);
        self.broadcast(&message);
    }

    pub fn add_peer(&self, peer: &str) {
        if peer.is_empty() {
            return;
        }
        self.peers.lock().unwrap().insert(peer.to_string(), now());
    }

    pub fn peers_list(&self) -> Vec<String> {
        let current = now();
        let mut guard = self.peers.lock().unwrap();
        guard.retain(|_, seen| current - *seen <= MESH_TTL);
        guard.keys().cloned().collect()
    }

    pub fn broadcast(&self, message: &Value) {
        let payload = format!("{}\n", serde_json::to_string(message).unwrap_or_default());
        for peer in self.peers_list() {
            let payload = payload.clone();
            std::thread::spawn(move || {
                if let Ok(mut conn) = TcpStream::connect_timeout(
                    &peer.parse().unwrap_or_else(|_| "127.0.0.1:0".parse().unwrap()),
                    Duration::from_secs(3),
                ) {
                    let _ = conn.write_all(payload.as_bytes());
                }
            });
        }
    }

    pub fn announce_block(&self, block: &Value) {
        let header = json!({
            "index": block.get("index"),
            "hash": block.get("hash"),
            "previous_hash": block.get("previous_hash"),
            "state_root": block.get("proof").and_then(|p| p.get("state_root")),
        });
        self.broadcast(&json!({"type": "BLOCK_ANNOUNCE", "header": header, "block": block}));
    }

    pub fn snapshot(&self) -> Value {
        let stats = self.task_stats.lock().unwrap();
        let recent: Vec<Value> = stats.recent.iter().rev().take(20).cloned().collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let pending: Vec<Value> = stats.pending_offers.values().cloned().collect();
        json!({
            "mesh_port": self.mesh_port,
            "protocol": PROTOCOL_VERSION,
            "mdns": false,
            "node_id": self.node_id,
            "peers": self.peers_list(),
            "task_gossip": {
                "offers": stats.offers,
                "claims": stats.claims,
                "results": stats.results,
                "finalized": stats.finalized,
                "recent": recent,
                "last_offer": stats.last_offer,
                "pending_offers": pending,
            },
        })
    }
}

/// Resolve a hub URL to `host:mesh_port` via its `/api/mesh` endpoint.
pub fn resolve_mesh_peer(hub_url: &str, default_port: u16) -> Option<String> {
    let url = hub_url.trim().trim_end_matches('/');
    if url.is_empty() {
        return None;
    }
    let hostname = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()?
        .split(':')
        .next()?
        .to_string();
    let mesh_port = crate::httpc::get_json(url, "/api/mesh", 5)
        .ok()
        .and_then(|data| data.get("mesh_port").and_then(Value::as_u64))
        .map(|p| p as u16)
        .unwrap_or(default_port);
    Some(format!("{hostname}:{mesh_port}"))
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "noetis-rust".into())
}
