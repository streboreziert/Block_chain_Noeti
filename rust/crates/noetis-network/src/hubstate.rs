//! Hub state machine — compute/relay registries, task dispatch, majority
//! consensus, rewards, slashing, and on-chain settlement.
//! Port of the Python `network_hub.py`.

use crate::consensus_net;
use crate::gossip::GossipMesh;
use noetis_chain::chain::{Chain, TrustMode};
use noetis_chain::pyjson::{round1, round4, round6, sha256_text};
use noetis_chain::state::{
    self, credit_tx, has_minimum_stake, slash_tx, validate_transaction, State, MIN_STAKE, SLASH_AMOUNT,
};
use noetis_chain::taskcrypto;
use noetis_chain::validators::Validators;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub const COMPUTE_TTL: f64 = 45.0;
pub const TASK_TIMEOUT: f64 = 120.0;
pub const DEFAULT_MODEL: &str = "qwen2.5:0.5b";

/// Normalize compute runtime: empty/unknown → "ollama"; allow "ollama"|"browser".
pub fn normalize_runtime(runtime: &str) -> String {
    let value = runtime.trim().to_lowercase();
    match value.as_str() {
        "ollama" | "browser" => value,
        _ => "ollama".into(),
    }
}

pub fn hub_blind() -> bool {
    matches!(
        std::env::var("HUB_BLIND")
            .unwrap_or_else(|_| "1".into())
            .trim()
            .to_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub fn mesh_consensus() -> bool {
    matches!(
        std::env::var("MESH_CONSENSUS")
            .unwrap_or_else(|_| "0".into())
            .trim()
            .to_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn now() -> f64 {
    noetis_chain::now()
}

fn time_hms(timestamp: f64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_opt(timestamp as i64, 0) {
        chrono::LocalResult::Single(dt) => dt.format("%H:%M:%S").to_string(),
        _ => String::new(),
    }
}

#[derive(Clone)]
pub struct ComputeNode {
    pub node_id: String,
    pub model: String,
    pub wallet_address: String,
    pub enc_pubkey: String,
    pub runtime: String,
    pub last_seen: f64,
    pub last_action: String,
    pub tasks_completed: i64,
    pub client_ip: String,
    pub access_url: String,
    pub status: String,
}

impl ComputeNode {
    pub fn is_online(&self) -> bool {
        now() - self.last_seen <= COMPUTE_TTL
    }

    pub fn to_dict(&self, balances: &HashMap<String, (f64, f64)>) -> Value {
        let (balance, staked) = balances.get(&self.wallet_address).copied().unwrap_or((0.0, 0.0));
        json!({
            "node_id": self.node_id,
            "worker_id": self.node_id,
            "model": self.model,
            "role": "compute",
            "runtime": normalize_runtime(&self.runtime),
            "address": if self.wallet_address.is_empty() { &self.node_id } else { &self.wallet_address },
            "wallet_address": self.wallet_address,
            "enc_pubkey": self.enc_pubkey,
            "mlc_address": self.wallet_address,
            "mlc_balance": balance,
            "mlc_staked": staked,
            "status": if self.is_online() { "online" } else { "offline" },
            "last_action": self.last_action,
            "tasks_completed": self.tasks_completed,
            "client_ip": self.client_ip,
            "access_url": self.access_url,
            "last_seen": self.last_seen,
        })
    }
}

#[derive(Clone)]
pub struct RelayNode {
    pub relay_id: String,
    pub last_seen: f64,
    pub last_action: String,
    pub tasks_relayed: i64,
    pub client_ip: String,
    pub access_url: String,
    pub status: String,
}

impl RelayNode {
    pub fn is_online(&self) -> bool {
        now() - self.last_seen <= COMPUTE_TTL
    }

    pub fn to_dict(&self) -> Value {
        json!({
            "relay_id": self.relay_id,
            "node_id": self.relay_id,
            "role": "relay",
            "status": if self.is_online() { "online" } else { "offline" },
            "last_action": self.last_action,
            "tasks_relayed": self.tasks_relayed,
            "address": self.relay_id,
            "client_ip": self.client_ip,
            "access_url": self.access_url,
            "last_seen": self.last_seen,
        })
    }
}

#[derive(Clone)]
pub struct TaskResultRow {
    pub worker_id: String,
    pub response: String,
    pub response_hash: String,
    pub inference_ms: f64,
    pub model: String,
    pub matched_consensus: bool,
    pub reward: f64,
}

#[derive(Clone)]
pub struct ActiveTask {
    pub task_id: String,
    pub prompt: String,
    pub prompt_hold: String,
    pub created: f64,
    pub prompt_hash: String,
    pub assigned: Vec<String>,
    pub results: Vec<TaskResultRow>,
    pub done: bool,
    pub relay_pending: bool,
    pub relay_id: Option<String>,
    pub ready_for_compute: bool,
    pub enc_by_node: HashMap<String, Value>,
    pub runtime: String,
}

impl ActiveTask {
    pub fn prompt_for_assign(&self) -> String {
        if !self.prompt.is_empty() {
            self.prompt.clone()
        } else {
            self.prompt_hold.clone()
        }
    }
}

pub struct Hub {
    pub hub_id: String,
    pub role: String,
    pub model: String,
    pub public_url: String,
    pub chain: Chain,
    pub validators: Validators,
    pub mesh: Arc<GossipMesh>,
    pub compute: HashMap<String, ComputeNode>,
    pub relays: HashMap<String, RelayNode>,
    pub tasks: HashMap<String, ActiveTask>,
    pub wallet_by_worker: HashMap<String, String>,
    pub events: Vec<Value>,
    pub stats: Vec<Value>,
    pub mempool: Vec<Value>,
    pub running_task: Option<String>,
    pub last_error: Option<String>,
}

impl Hub {
    pub fn log(&mut self, kind: &str, message: &str) {
        self.events.push(json!({
            "time": time_hms(now()),
            "kind": kind,
            "message": message,
            "node_id": Value::Null,
            "task_id": Value::Null,
        }));
        let overflow = self.events.len().saturating_sub(200);
        if overflow > 0 {
            self.events.drain(..overflow);
        }
    }

    pub fn state(&mut self) -> State {
        self.chain.current_state()
    }

    pub fn trust_mode(&mut self) -> TrustMode {
        let state = self.chain.current_state();
        TrustMode::Registry {
            known: self.validators.known_validators(&state),
            quorum: self.effective_quorum(),
        }
    }

    pub fn effective_quorum(&mut self) -> usize {
        let state = self.chain.current_state();
        let known = self.validators.known_validators(&state).len();
        self.validators.effective_quorum().clamp(1, known.max(1))
    }

    pub fn sorted_validator_pubkeys(&mut self) -> Vec<String> {
        let state = self.chain.current_state();
        self.validators.known_validators(&state).keys().cloned().collect()
    }

    fn balances_index(&mut self) -> HashMap<String, (f64, f64)> {
        self.state()
            .iter()
            .map(|(addr, row)| (addr.clone(), (row.balance, row.staked)))
            .collect()
    }

    // ---- registration -------------------------------------------------

    pub fn register_relay(&mut self, relay_id: &str, client_ip: &str, access_url: &str) -> Result<Value, String> {
        let relay_id = relay_id.trim();
        if relay_id.is_empty() {
            return Err("relay_id required".into());
        }
        let relay = self.relays.entry(relay_id.to_string()).or_insert_with(|| RelayNode {
            relay_id: relay_id.to_string(),
            last_seen: now(),
            last_action: "Relay online".into(),
            tasks_relayed: 0,
            client_ip: String::new(),
            access_url: String::new(),
            status: "online".into(),
        });
        relay.last_seen = now();
        relay.status = "online".into();
        relay.last_action = "Routing layer active".into();
        if !client_ip.is_empty() {
            relay.client_ip = client_ip.to_string();
        }
        if !access_url.is_empty() {
            relay.access_url = access_url.trim().trim_end_matches('/').to_string();
        }
        self.log("relay", &format!("Relay joined: {relay_id}"));
        Ok(json!({"ok": true, "relay_id": relay_id, "address": relay_id, "hub": self.hub_id}))
    }

    pub fn relay_heartbeat(&mut self, relay_id: &str) -> Result<Value, String> {
        match self.relays.get_mut(relay_id) {
            Some(relay) => {
                relay.last_seen = now();
                Ok(json!({"ok": true}))
            }
            None => Err("Not registered — call /api/relay/register first".into()),
        }
    }

    pub fn register_compute(
        &mut self,
        node_id: &str,
        model: &str,
        wallet_address: &str,
        enc_pubkey: &str,
        client_ip: &str,
        access_url: &str,
        runtime: &str,
    ) -> Result<Value, String> {
        let node_id = node_id.trim();
        let wallet_address = wallet_address.trim();
        let runtime = normalize_runtime(runtime);
        if node_id.is_empty() {
            return Err("node_id required".into());
        }
        if wallet_address.is_empty() {
            return Err("wallet_address required — create a wallet first".into());
        }
        let chain_state = self.state();
        if !has_minimum_stake(&chain_state, wallet_address, node_id) {
            let staked = chain_state.get(wallet_address).map(|r| r.staked).unwrap_or(0.0);
            return Err(format!(
                "Stake at least {MIN_STAKE} MLC for node {node_id} (staked: {staked})"
            ));
        }
        let default_model = self.model.clone();
        let hub_id = self.hub_id.clone();
        let staked = chain_state.get(wallet_address).map(|r| r.staked).unwrap_or(0.0);
        let node = self.compute.entry(node_id.to_string()).or_insert_with(|| ComputeNode {
            node_id: node_id.to_string(),
            model: if model.is_empty() { default_model } else { model.to_string() },
            wallet_address: wallet_address.to_string(),
            enc_pubkey: enc_pubkey.to_string(),
            runtime: runtime.clone(),
            last_seen: now(),
            last_action: "Joined network".into(),
            tasks_completed: 0,
            client_ip: String::new(),
            access_url: String::new(),
            status: "online".into(),
        });
        if !model.is_empty() {
            node.model = model.to_string();
        }
        node.wallet_address = wallet_address.to_string();
        if !enc_pubkey.is_empty() {
            node.enc_pubkey = enc_pubkey.to_string();
        }
        node.runtime = runtime.clone();
        node.last_seen = now();
        node.status = "online".into();
        node.last_action = format!(
            "Staked ≥{MIN_STAKE} MLC · {runtime} — E2E {}",
            if node.enc_pubkey.is_empty() { "off" } else { "on" }
        );
        if !client_ip.is_empty() {
            node.client_ip = client_ip.to_string();
        }
        if !access_url.is_empty() {
            node.access_url = access_url.trim().trim_end_matches('/').to_string();
        }
        let enc = node.enc_pubkey.clone();
        self.wallet_by_worker.insert(node_id.to_string(), wallet_address.to_string());
        self.log("join", &format!("Compute node joined: {node_id} ({runtime})"));
        Ok(json!({
            "ok": true,
            "node_id": node_id,
            "address": wallet_address,
            "wallet_address": wallet_address,
            "enc_pubkey": enc,
            "runtime": runtime,
            "encrypted_tasks": !enc.is_empty(),
            "staked": staked,
            "hub": hub_id,
        }))
    }

    pub fn compute_heartbeat(&mut self, node_id: &str) -> Result<Value, String> {
        match self.compute.get_mut(node_id) {
            Some(node) => {
                node.last_seen = now();
                Ok(json!({"ok": true}))
            }
            None => Err("Not registered — call /api/compute/register first".into()),
        }
    }

    /// Immediately remove a compute node from the live mesh (Stop Earn / graceful leave).
    pub fn unregister_compute(&mut self, node_id: &str) -> Result<Value, String> {
        let node_id = node_id.trim();
        if node_id.is_empty() {
            return Err("node_id required".into());
        }
        let removed = self.compute.remove(node_id);
        self.wallet_by_worker.remove(node_id);
        match removed {
            None => {
                self.log("leave", &format!("Compute leave (already gone): {node_id}"));
                Ok(json!({"ok": true, "node_id": node_id, "was_online": false}))
            }
            Some(node) => {
                self.log("leave", &format!("Compute left network: {node_id}"));
                Ok(json!({
                    "ok": true,
                    "node_id": node_id,
                    "was_online": true,
                    "wallet_address": node.wallet_address,
                }))
            }
        }
    }

    pub fn online_compute_count(&self) -> usize {
        self.compute.values().filter(|n| n.is_online()).count()
    }

    pub fn online_compute_count_for_runtime(&self, runtime: &str) -> usize {
        let rt = normalize_runtime(runtime);
        self.compute
            .values()
            .filter(|n| n.is_online() && normalize_runtime(&n.runtime) == rt)
            .count()
    }

    pub fn runtime_counts(&self) -> (usize, usize) {
        let mut ollama_n = 0usize;
        let mut browser_n = 0usize;
        for node in self.compute.values().filter(|n| n.is_online()) {
            match normalize_runtime(&node.runtime).as_str() {
                "browser" => browser_n += 1,
                _ => ollama_n += 1,
            }
        }
        (ollama_n, browser_n)
    }

    pub fn pick_task_runtime(&self) -> String {
        let (ollama_n, browser_n) = self.runtime_counts();
        if ollama_n > 0 {
            "ollama".into()
        } else if browser_n > 0 {
            "browser".into()
        } else {
            "ollama".into()
        }
    }

    pub fn online_relay_count(&self) -> usize {
        self.relays.values().filter(|r| r.is_online()).count()
    }

    // ---- task flow -----------------------------------------------------

    pub fn start_task(&mut self, prompt: &str) -> Result<String, String> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err("Prompt required".into());
        }
        if self.running_task.is_some() {
            return Err("Inference in progress".into());
        }
        let task_id: String = {
            use rand::Rng;
            let mut rng = rand::thread_rng();
            (0..12).map(|_| format!("{:x}", rng.gen_range(0..16))).collect()
        };
        let task_runtime = self.pick_task_runtime();
        let created = now();
        let prompt_hash = sha256_text(prompt);
        self.tasks.insert(
            task_id.clone(),
            ActiveTask {
                task_id: task_id.clone(),
                prompt: prompt.to_string(),
                prompt_hold: if hub_blind() { prompt.to_string() } else { String::new() },
                created,
                prompt_hash: prompt_hash.clone(),
                assigned: vec![],
                results: vec![],
                done: false,
                relay_pending: true,
                relay_id: None,
                ready_for_compute: false,
                enc_by_node: HashMap::new(),
                runtime: task_runtime.clone(),
            },
        );
        self.running_task = Some(task_id.clone());
        self.last_error = None;

        // Auto-relay when no external relay is online.
        if self.online_relay_count() == 0 {
            if let Some(task) = self.tasks.get_mut(&task_id) {
                task.relay_id = Some("hub-relay".into());
                task.relay_pending = false;
                task.ready_for_compute = true;
            }
            self.log("relay", &format!("Task {task_id} auto-routed via hub relay"));
        }
        let relays = self.online_relay_count();
        self.log(
            "task",
            &format!("User prompt received — routing via relay layer ({relays} relay(s) online)"),
        );
        self.mesh.gossip_task_offer(
            &task_id,
            &prompt_hash,
            &task_runtime,
            &self.model,
            &self.hub_id,
            created,
        );
        Ok(task_id)
    }

    pub fn poll_relay_task(&mut self, relay_id: &str) -> Result<Option<Value>, String> {
        if !self.relays.contains_key(relay_id) {
            return Err("Not registered".into());
        }
        self.relays.get_mut(relay_id).unwrap().last_seen = now();
        let mut picked: Option<(String, String)> = None;
        for task in self.tasks.values_mut() {
            if task.done || !task.relay_pending || task.relay_id.is_some() {
                continue;
            }
            task.relay_id = Some(relay_id.to_string());
            picked = Some((task.task_id.clone(), task.prompt.clone()));
            break;
        }
        if let Some((task_id, prompt)) = picked {
            let relay = self.relays.get_mut(relay_id).unwrap();
            relay.status = "routing".into();
            relay.last_action = format!("Relaying {task_id}");
            return Ok(Some(json!({"task_id": task_id, "prompt": prompt, "anonymous": true})));
        }
        Ok(None)
    }

    pub fn forward_relay_task(&mut self, relay_id: &str, task_id: &str) -> Result<Value, String> {
        if !self.relays.contains_key(relay_id) {
            return Err("Relay not registered".into());
        }
        {
            let task = self.tasks.get_mut(task_id).ok_or("Task not found")?;
            if task.done {
                return Err("Task not found".into());
            }
            if task.relay_id.as_deref() != Some(relay_id) {
                return Err("Task not assigned to this relay".into());
            }
            task.relay_pending = false;
            task.ready_for_compute = true;
        }
        let relay = self.relays.get_mut(relay_id).unwrap();
        relay.status = "online".into();
        relay.last_action = format!("Forwarded {task_id} to compute pool");
        relay.tasks_relayed += 1;
        relay.last_seen = now();
        self.log(
            "relay",
            &format!("{relay_id} forwarded anonymous task to compute — user identity hidden"),
        );
        Ok(json!({"ok": true, "task_id": task_id}))
    }

    pub fn list_open_offers(&mut self, node_id: &str) -> Result<Vec<Value>, String> {
        let (wallet_address, enc_pubkey, node_runtime) = match self.compute.get(node_id) {
            Some(node) => (
                node.wallet_address.clone(),
                node.enc_pubkey.clone(),
                normalize_runtime(&node.runtime),
            ),
            None => return Err("Not registered".into()),
        };
        let chain_state = self.state();
        if !has_minimum_stake(&chain_state, &wallet_address, node_id) {
            return Err(format!("Insufficient stake — lock at least {MIN_STAKE} MLC"));
        }
        if hub_blind() && enc_pubkey.is_empty() {
            return Err(
                "HUB_BLIND requires enc_pubkey — regenerate compute keys and re-register".into(),
            );
        }
        if let Some(node) = self.compute.get_mut(node_id) {
            node.last_seen = now();
        }
        let mut ready: Vec<Value> = vec![];
        for task in self.tasks.values() {
            if task.done || !task.ready_for_compute || task.assigned.contains(&node_id.to_string()) {
                continue;
            }
            if normalize_runtime(&task.runtime) != node_runtime {
                continue;
            }
            ready.push(json!({
                "task_id": task.task_id,
                "prompt_hash": task.prompt_hash,
                "runtime": normalize_runtime(&task.runtime),
                "created_at": task.created,
            }));
        }
        ready.sort_by(|a, b| {
            let ca = a.get("created_at").and_then(Value::as_f64).unwrap_or(0.0);
            let cb = b.get("created_at").and_then(Value::as_f64).unwrap_or(0.0);
            ca.partial_cmp(&cb).unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(ready)
    }

    pub fn claim_compute_task(&mut self, node_id: &str, task_id: &str) -> Result<Value, String> {
        let task_id = task_id.trim();
        if task_id.is_empty() {
            return Err("task_id required".into());
        }
        match self.assign_compute_task(node_id, Some(task_id))? {
            Some(payload) => Ok(payload),
            None => Err("Offer unavailable or already claimed".into()),
        }
    }

    pub fn poll_compute_task(&mut self, node_id: &str) -> Result<Option<Value>, String> {
        self.assign_compute_task(node_id, None)
    }

    pub fn assign_compute_task(
        &mut self,
        node_id: &str,
        task_id: Option<&str>,
    ) -> Result<Option<Value>, String> {
        let (wallet_address, enc_pubkey, node_runtime) = match self.compute.get(node_id) {
            Some(node) => (
                node.wallet_address.clone(),
                node.enc_pubkey.clone(),
                normalize_runtime(&node.runtime),
            ),
            None => return Err("Not registered".into()),
        };
        let chain_state = self.state();
        if !has_minimum_stake(&chain_state, &wallet_address, node_id) {
            return Err(format!("Insufficient stake — lock at least {MIN_STAKE} MLC"));
        }
        if hub_blind() && enc_pubkey.is_empty() {
            return Err(
                "HUB_BLIND requires enc_pubkey — regenerate compute keys and re-register".into(),
            );
        }
        if let Some(node) = self.compute.get_mut(node_id) {
            node.last_seen = now();
        }

        let mut payload: Option<Value> = None;
        let mut assigned_task: Option<String> = None;
        for task in self.tasks.values_mut() {
            if let Some(want) = task_id {
                if task.task_id != want {
                    continue;
                }
            }
            if task.done || !task.ready_for_compute || task.assigned.contains(&node_id.to_string()) {
                continue;
            }
            if normalize_runtime(&task.runtime) != node_runtime {
                continue;
            }
            let plaintext = task.prompt_for_assign();
            if plaintext.is_empty() && enc_pubkey.is_empty() {
                continue;
            }
            task.assigned.push(node_id.to_string());
            if task.prompt_hash.is_empty() && !plaintext.is_empty() {
                task.prompt_hash = sha256_text(&plaintext);
            }
            let mut body = Map::new();
            body.insert("task_id".into(), json!(task.task_id));
            body.insert("prompt_hash".into(), json!(task.prompt_hash));
            body.insert("runtime".into(), json!(normalize_runtime(&task.runtime)));
            body.insert("anonymous".into(), json!(true));
            body.insert("via_relay".into(), json!(true));
            body.insert("hub_blind".into(), json!(hub_blind()));
            // Plaintext only when hub-blind is off, or legacy browser without keys.
            let allow_plaintext =
                !hub_blind() || (node_runtime == "browser" && enc_pubkey.is_empty());
            if !enc_pubkey.is_empty() && !plaintext.is_empty() {
                if let Some(enc) = taskcrypto::encrypt_task(&plaintext, &enc_pubkey) {
                    let mut enc_map = enc.as_object().cloned().unwrap_or_default();
                    let hub_priv = enc_map.remove("_hub_ephem_priv").unwrap_or(Value::Null);
                    let mut stored = enc_map.clone();
                    stored.insert("_hub_ephem_priv".into(), hub_priv);
                    task.enc_by_node.insert(node_id.to_string(), Value::Object(stored));
                    for (key, value) in enc_map {
                        body.insert(key, value);
                    }
                    if hub_blind() {
                        if task.prompt_hold.is_empty() {
                            task.prompt_hold = plaintext;
                        }
                        task.prompt.clear();
                    }
                } else if allow_plaintext {
                    body.insert("prompt".into(), json!(plaintext));
                }
            } else if allow_plaintext {
                body.insert("prompt".into(), json!(plaintext));
            } else {
                task.assigned.retain(|id| id != node_id);
                continue;
            }
            assigned_task = Some(task.task_id.clone());
            payload = Some(Value::Object(body));
            break;
        }
        if let Some(ref tid) = assigned_task {
            if let Some(node) = self.compute.get_mut(node_id) {
                node.status = "inferring".into();
                node.last_action = format!("Task {tid}");
            }
            self.mesh.gossip_task_claim(tid, node_id, &node_runtime);
        }
        Ok(payload)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn submit_result(
        &mut self,
        task_id: &str,
        node_id: &str,
        mut response: String,
        inference_ms: f64,
        model: &str,
        attestation: Option<&Value>,
        response_encrypted: bool,
        response_ciphertext: &str,
        response_nonce: &str,
    ) -> Result<Value, String> {
        // Decrypt E2E responses.
        if response_encrypted {
            let enc_meta = self
                .tasks
                .get(task_id)
                .and_then(|t| t.enc_by_node.get(node_id))
                .cloned();
            let node_pub = self.compute.get(node_id).map(|n| n.enc_pubkey.clone()).unwrap_or_default();
            if let (Some(meta), false) = (enc_meta, node_pub.is_empty()) {
                let hub_priv = meta.get("_hub_ephem_priv").and_then(Value::as_str).unwrap_or("");
                if !hub_priv.is_empty() {
                    let payload = json!({
                        "response_encrypted": true,
                        "response_ciphertext": response_ciphertext,
                        "response_nonce": response_nonce,
                    });
                    response = taskcrypto::decrypt_response(&payload, hub_priv, &node_pub)
                        .ok_or("Failed to decrypt response")?;
                }
            }
        }

        if let Some(att) = attestation {
            noetis_chain::attestation::verify_attestation(att)
                .map_err(|reason| format!("Invalid model attestation: {reason}"))?;
            if att.get("output_hash").and_then(Value::as_str) != Some(sha256_text(&response).as_str()) {
                return Err("Attestation output hash mismatch".into());
            }
            if att.get("model").and_then(Value::as_str) != Some(model) {
                return Err("Attestation model mismatch".into());
            }
        }

        let response_hash = attestation
            .and_then(|a| a.get("output_hash").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| sha256_text(&response));
        let node_runtime = self
            .compute
            .get(node_id)
            .map(|n| normalize_runtime(&n.runtime))
            .unwrap_or_else(|| "ollama".into());
        let store_response = if hub_blind() && node_runtime != "browser" {
            String::new()
        } else {
            response.clone()
        };

        let task_runtime = match self.tasks.get(task_id) {
            Some(task) if !task.done => normalize_runtime(&task.runtime),
            _ => {
                return Ok(json!({"ok": false, "error": "Task not found or already finalized"}));
            }
        };
        let expected = self.online_compute_count_for_runtime(&task_runtime).max(1);
        let ready;
        {
            let Some(task) = self.tasks.get_mut(task_id) else {
                return Ok(json!({"ok": false, "error": "Task not found or already finalized"}));
            };
            if task.done {
                return Ok(json!({"ok": false, "error": "Task not found or already finalized"}));
            }
            if task.results.iter().any(|r| r.worker_id == node_id) {
                return Ok(json!({"ok": true, "duplicate": true}));
            }
            // Keep plaintext in response for winner finalize when hub-blind wiped the row field.
            let row_response = if store_response.is_empty() {
                response
            } else {
                store_response
            };
            task.results.push(TaskResultRow {
                worker_id: node_id.to_string(),
                response: if hub_blind() && node_runtime != "browser" {
                    // Temporarily keep for finalize winner pick; cleared for non-winners below.
                    row_response
                } else {
                    row_response
                },
                response_hash: response_hash.clone(),
                inference_ms,
                model: model.to_string(),
                matched_consensus: false,
                reward: 0.0,
            });
            ready = task.results.len() >= expected.min(3) || task.results.len() >= expected;
        }
        if let Some(node) = self.compute.get_mut(node_id) {
            node.status = "online".into();
            node.last_action = format!("Finished in {inference_ms:.0}ms");
            node.tasks_completed += 1;
            node.last_seen = now();
        }
        self.log("infer", &format!("{node_id} returned result"));
        self.mesh
            .gossip_task_result(task_id, node_id, &response_hash, model);

        if ready {
            self.finalize_task(task_id)?;
            if self.running_task.as_deref() == Some(task_id) {
                self.running_task = None;
            }
        }
        Ok(json!({"ok": true}))
    }

    // ---- consensus + settlement ----------------------------------------

    pub fn finalize_task(&mut self, task_id: &str) -> Result<(), String> {
        let (prompt_hash, mut results) = {
            let Some(task) = self.tasks.get_mut(task_id) else { return Ok(()) };
            if task.done || task.results.is_empty() {
                return Ok(());
            }
            task.done = true;
            let ph = if task.prompt_hash.is_empty() {
                sha256_text(&task.prompt_for_assign())
            } else {
                task.prompt_hash.clone()
            };
            task.prompt.clear();
            task.prompt_hold.clear();
            (ph, task.results.clone())
        };

        let consensus;
        if hub_blind() && results.iter().any(|r| !r.response_hash.is_empty()) {
            // Majority on response hashes; keep only winner plaintext for chat.
            let mut buckets: HashMap<String, usize> = HashMap::new();
            for row in &results {
                if !row.response_hash.is_empty() {
                    *buckets.entry(row.response_hash.clone()).or_default() += 1;
                }
            }
            let winner_hash = buckets
                .into_iter()
                .max_by_key(|(_, n)| *n)
                .map(|(h, _)| h)
                .unwrap_or_default();
            consensus = results
                .iter()
                .find(|r| r.response_hash == winner_hash)
                .map(|r| r.response.clone())
                .unwrap_or_default();
            let total_score: f64 = results
                .iter()
                .filter(|r| r.response_hash == winner_hash)
                .map(|r| 1.0 / r.inference_ms.max(1.0))
                .sum();
            for row in &mut results {
                if row.response_hash == winner_hash && total_score > 0.0 {
                    row.matched_consensus = true;
                    row.reward = round4(10.0 * (1.0 / row.inference_ms.max(1.0)) / total_score);
                } else {
                    row.matched_consensus = false;
                    row.reward = 0.0;
                    row.response.clear();
                }
            }
            self.log("consensus", "Hash majority consensus reached (hub-blind)");
        } else {
            // Majority consensus over normalized responses.
            let normalize = |text: &str| -> String {
                text.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
            };
            let mut buckets: HashMap<String, Vec<String>> = HashMap::new();
            let mut order: Vec<String> = vec![];
            for row in &results {
                let key = normalize(&row.response);
                if !buckets.contains_key(&key) {
                    order.push(key.clone());
                }
                buckets.entry(key).or_default().push(row.response.clone());
            }
            let winner_key = order
                .iter()
                .max_by_key(|key| buckets.get(*key).map(|v| v.len()).unwrap_or(0))
                .cloned()
                .unwrap_or_default();
            consensus = buckets
                .get(&winner_key)
                .and_then(|v| v.first())
                .cloned()
                .unwrap_or_default();
            self.log("consensus", "Majority consensus reached");

            let target = normalize(&consensus);
            let total_score: f64 = results
                .iter()
                .filter(|r| normalize(&r.response) == target)
                .map(|r| 1.0 / r.inference_ms.max(1.0))
                .sum();
            for row in &mut results {
                if normalize(&row.response) != target || total_score <= 0.0 {
                    row.matched_consensus = false;
                    row.reward = 0.0;
                } else {
                    row.matched_consensus = true;
                    row.reward = round4(10.0 * (1.0 / row.inference_ms.max(1.0)) / total_score);
                }
            }
        }
        let prompt = String::new();

        // Slash outliers.
        let chain_state = self.state();
        let mut slash_transactions = vec![];
        for row in &results {
            if row.matched_consensus {
                continue;
            }
            let Some(address) = self.wallet_by_worker.get(&row.worker_id).cloned() else { continue };
            let account = chain_state.get(&address).cloned().unwrap_or_default();
            if account.staked + account.balance <= 0.0 {
                continue;
            }
            slash_transactions.push(slash_tx(
                &address,
                SLASH_AMOUNT,
                &row.worker_id,
                "Consensus outlier — response did not match majority",
                task_id,
            ));
        }
        if !slash_transactions.is_empty() {
            self.log(
                "slash",
                &format!("Slashing {} outlier(s) — Sybil resistance", slash_transactions.len()),
            );
        }

        // Transactions: mempool + rewards + slashes.
        let mut transactions: Vec<Value> = self.mempool.drain(..).collect();
        for row in &results {
            if !row.matched_consensus || row.reward <= 0.0 {
                continue;
            }
            let address = self
                .wallet_by_worker
                .get(&row.worker_id)
                .cloned()
                .unwrap_or_else(|| row.worker_id.clone());
            transactions.push(credit_tx(
                &address,
                row.reward,
                &format!("Inference reward — task {task_id}"),
                &row.worker_id,
                task_id,
            ));
        }
        transactions.extend(slash_transactions);

        let worker_rows: Vec<Value> = results
            .iter()
            .map(|row| {
                let rh = if !row.response_hash.is_empty() {
                    row.response_hash.clone()
                } else {
                    sha256_text(&row.response)
                };
                json!({
                    "task_id": task_id,
                    "worker_id": row.worker_id,
                    "response_hash": rh,
                    "inference_ms": round1(row.inference_ms),
                    "model": row.model,
                    "matched_consensus": row.matched_consensus,
                    "reward": round4(row.reward),
                })
            })
            .collect();

        let winner = results
            .iter()
            .filter(|r| r.matched_consensus)
            .min_by(|a, b| a.inference_ms.partial_cmp(&b.inference_ms).unwrap_or(std::cmp::Ordering::Equal))
            .map(|r| r.worker_id.clone());
        let matched = results.iter().filter(|r| r.matched_consensus).count();

        let consensus_hash = sha256_text(&consensus);
        let proposer = {
            let pubkeys = self.sorted_validator_pubkeys();
            noetis_chain::schedule::proposer_pubkey_for_height(self.chain.last_block().index + 1, &pubkeys)
        };
        let quorum = self.effective_quorum();
        let local_info = self.validators.info();
        let chain_state2 = self.chain.current_state();
        let known = self.validators.known_validators(&chain_state2);
        let local_blocks = self.chain.to_dicts();

        let block = self.chain.add_inference_block(
            task_id,
            &prompt_hash,
            &consensus_hash,
            worker_rows,
            transactions,
            results.len(),
            matched,
            winner,
            &self.validators,
            &proposer,
            |block_dict| consensus_net::collect_cosignatures(block_dict, &local_info, &known, &local_blocks),
            quorum,
        )?;
        self.mesh.announce_block(&block.to_dict());
        let distributed = block.proof.get("mlc_distributed").and_then(Value::as_f64).unwrap_or(0.0);
        self.log(
            "block",
            &format!("Block #{} committed — {} MLC on-chain", block.index, distributed),
        );

        self.stats.push(json!({
            "task_id": task_id,
            "prompt": prompt,
            "prompt_hash": prompt_hash,
            "consensus_response": consensus,
            "workers_responded": results.len(),
            "workers_matched": matched,
            "results": results.iter().map(|r| json!({
                "task_id": task_id,
                "worker_id": r.worker_id,
                "prompt": "",
                "response": r.response,
                "response_hash": r.response_hash,
                "inference_ms": round1(r.inference_ms),
                "model": r.model,
                "matched_consensus": r.matched_consensus,
                "reward": round4(r.reward),
            })).collect::<Vec<_>>(),
        }));
        Ok(())
    }

    /// Commit a signed transaction directly as a state block.
    pub fn add_signed_tx_block(&mut self, tx: Value) -> Result<Value, String> {
        let tx_type = tx.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        if !state::is_signed_type(&tx_type) {
            return Err("Only signed transaction types accepted".into());
        }
        let mut chain_state = self.state();
        if let Some(error) = validate_transaction(&tx, &mut chain_state) {
            return Err(error);
        }
        let amount = tx.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
        let block = self.commit_state_block(vec![tx], &format!("Signed {tx_type}"))?;
        self.log("tx", &format!("On-chain {tx_type} {amount} MLC"));
        Ok(json!({"ok": true, "block_index": block, "on_chain": true}))
    }

    pub fn commit_state_block(&mut self, transactions: Vec<Value>, data: &str) -> Result<i64, String> {
        let proposer = {
            let pubkeys = self.sorted_validator_pubkeys();
            noetis_chain::schedule::proposer_pubkey_for_height(self.chain.last_block().index + 1, &pubkeys)
        };
        let quorum = self.effective_quorum();
        let local_info = self.validators.info();
        let chain_state = self.chain.current_state();
        let known = self.validators.known_validators(&chain_state);
        let local_blocks = self.chain.to_dicts();
        let block = self.chain.add_state_block(
            transactions,
            data,
            &self.validators,
            &proposer,
            |block_dict| consensus_net::collect_cosignatures(block_dict, &local_info, &known, &local_blocks),
            quorum,
        )?;
        self.mesh.announce_block(&block.to_dict());
        Ok(block.index)
    }

    // ---- faucet ---------------------------------------------------------

    pub fn faucet_mode(&self) -> String {
        std::env::var("ALLOW_FAUCET").unwrap_or_else(|_| "0".into()).trim().to_lowercase()
    }

    pub fn faucet_allowed(&self) -> bool {
        matches!(self.faucet_mode().as_str(), "1" | "true" | "yes" | "limited" | "rate_limited")
    }

    fn faucet_claims_path(&self) -> std::path::PathBuf {
        self.validators.data_dir.join("faucet_claims.json")
    }

    fn faucet_max(&self) -> f64 {
        std::env::var("FAUCET_MAX_AMOUNT").ok().and_then(|v| v.parse().ok()).unwrap_or(50.0)
    }

    fn faucet_cooldown(&self) -> f64 {
        std::env::var("FAUCET_COOLDOWN_SEC").ok().and_then(|v| v.parse().ok()).unwrap_or(86_400.0)
    }

    pub fn can_claim_faucet(&self, address: &str) -> (bool, String) {
        if !self.faucet_allowed() {
            return (false, "transfer MLC or earn — faucet is off".into());
        }
        let claims: HashMap<String, f64> = std::fs::read_to_string(self.faucet_claims_path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        if let Some(last) = claims.get(address) {
            let elapsed = now() - last;
            if elapsed < self.faucet_cooldown() {
                let remaining = (self.faucet_cooldown() - elapsed) as i64;
                return (
                    false,
                    format!("Already claimed — retry in {}h {}m", remaining / 3600, (remaining % 3600) / 60),
                );
            }
        }
        (true, "eligible".into())
    }

    pub fn grant_faucet(&mut self, address: &str, amount: f64) -> Result<Value, String> {
        let mode = self.faucet_mode();
        if !self.faucet_allowed() {
            return Err("transfer MLC or earn — faucet is off".into());
        }
        let (eligible, reason) = self.can_claim_faucet(address);
        let limited = matches!(mode.as_str(), "limited" | "rate_limited");
        if limited && !eligible {
            return Err(reason);
        }
        let credit_amount = if limited {
            round6(amount.min(self.faucet_max()))
        } else {
            round6(amount)
        };
        let reason_text = if limited { "Mainnet onboarding faucet" } else { "Dev faucet credit" };
        let tx = credit_tx(address, credit_amount, reason_text, "", "");
        let block_index = self.commit_state_block(vec![tx], &format!("Faucet — {credit_amount} MLC"))?;

        // Record the claim.
        let mut claims: HashMap<String, f64> = std::fs::read_to_string(self.faucet_claims_path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        claims.insert(address.to_string(), now());
        let _ = std::fs::write(
            self.faucet_claims_path(),
            serde_json::to_string_pretty(&claims).unwrap_or_default(),
        );
        self.log("faucet", &format!("Credited {credit_amount} MLC to {address}"));
        Ok(json!({
            "ok": true,
            "address": address,
            "amount": credit_amount,
            "block_index": block_index,
            "mode": mode,
        }))
    }

    // ---- mempool ---------------------------------------------------------

    pub fn add_to_mempool(&mut self, tx: Value) -> Result<Value, String> {
        let mut chain_state = self.state();
        if let Some(error) = validate_transaction(&tx, &mut chain_state) {
            return Err(error);
        }
        let duplicate = self.mempool.iter().any(|pending| {
            pending.get("from") == tx.get("from") && pending.get("nonce") == tx.get("nonce")
        });
        if duplicate {
            return Err("Duplicate transaction in mempool".into());
        }
        self.mempool.push(tx);
        Ok(json!({"ok": true, "message": "accepted", "mempool": true}))
    }

    // ---- expiry ----------------------------------------------------------

    pub fn expire_stale_tasks(&mut self) {
        let current = now();
        let mut expired: Vec<String> = vec![];
        for (task_id, task) in &mut self.tasks {
            if !task.done && current - task.created > TASK_TIMEOUT {
                task.done = true;
                expired.push(task_id.clone());
            }
        }
        for task_id in expired {
            if self.running_task.as_deref() == Some(task_id.as_str()) {
                self.running_task = None;
            }
            self.last_error = Some("Task timed out — no compute response".into());
            self.log("error", "Task timed out — no compute response");
        }
    }

    // ---- ledger (transactions view) ---------------------------------------

    pub fn ledger(&self, limit: usize) -> Vec<Value> {
        let mut entries = vec![];
        for block in self.chain.blocks.iter().rev() {
            let txs = block.transactions();
            for tx in txs.iter().rev() {
                let tx_type = tx.get("type").and_then(Value::as_str).unwrap_or("");
                let time = tx.get("timestamp").and_then(Value::as_f64).unwrap_or(block.timestamp);
                let entry = match tx_type {
                    "credit" => json!({
                        "time": time,
                        "address": tx.get("to"),
                        "name": tx.get("worker_id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(Value::from).unwrap_or_else(|| tx.get("to").cloned().unwrap_or(Value::Null)),
                        "amount": tx.get("amount"),
                        "token": "MLC",
                        "reason": tx.get("reason").cloned().unwrap_or(json!("credit")),
                        "block_index": block.index,
                        "type": tx_type,
                    }),
                    "transfer" => json!({
                        "time": time,
                        "address": tx.get("from"),
                        "name": tx.get("from"),
                        "amount": -(tx.get("amount").and_then(Value::as_f64).unwrap_or(0.0)),
                        "token": "MLC",
                        "reason": format!("Transfer to {}", tx.get("to").and_then(Value::as_str).unwrap_or("")),
                        "block_index": block.index,
                        "type": tx_type,
                    }),
                    "stake" | "slash" | "unstake" => json!({
                        "time": time,
                        "address": tx.get("from"),
                        "name": tx.get("node_id").cloned().unwrap_or_else(|| tx.get("from").cloned().unwrap_or(Value::Null)),
                        "amount": tx.get("amount"),
                        "token": "MLC",
                        "reason": tx.get("reason").cloned().unwrap_or_else(|| json!(tx_type)),
                        "block_index": block.index,
                        "type": tx_type,
                    }),
                    _ => continue,
                };
                entries.push(entry);
                if entries.len() >= limit {
                    return entries;
                }
            }
        }
        entries
    }

    pub fn balances_rows(&mut self) -> Vec<Value> {
        let chain_state = self.state();
        let mut rows: Vec<Value> = chain_state
            .iter()
            .map(|(address, row)| {
                json!({
                    "address": address,
                    "worker_id": row.node_id.clone().unwrap_or_else(|| address.clone()),
                    "name": row.node_id.clone().unwrap_or_else(|| address.chars().take(16).collect()),
                    "balance": round6(row.balance),
                    "staked": round6(row.staked),
                    "total": round6(row.balance + row.staked),
                    "blocks_earned": 0,
                    "tasks_completed": 0,
                })
            })
            .collect();
        rows.sort_by(|a, b| {
            let ta = a.get("total").and_then(Value::as_f64).unwrap_or(0.0);
            let tb = b.get("total").and_then(Value::as_f64).unwrap_or(0.0);
            tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
        });
        rows
    }

    pub fn nodes_snapshot(&mut self) -> (Vec<Value>, Vec<Value>) {
        let balances = self.balances_index();
        let nodes: Vec<Value> = self
            .compute
            .values()
            .filter(|n| n.is_online())
            .map(|n| n.to_dict(&balances))
            .collect();
        let relays: Vec<Value> = self.relays.values().filter(|r| r.is_online()).map(|r| r.to_dict()).collect();
        (nodes, relays)
    }
}
