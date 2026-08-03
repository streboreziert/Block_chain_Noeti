//! Proof-of-Inference blockchain — port of Python `inference_chain.py`.
//!
//! Same block format, same hashes, same SQLite schema (`chain.db`), so a Rust
//! node can adopt a Python hub's data directory and vice versa.

use crate::block::{worker_rows_merkle_root, Block, CHAIN_VERSION, PROOF_TYPE};
use crate::pyjson::round4;
use crate::spv::state_root;
use crate::state::{apply_transactions, rebuild_state_from_chain, State};
use crate::validators::{signature_count, verify_block_signature, ValidatorInfo, Validators};
use crate::wallet::Wallet;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const DEFAULT_MAX_REORG_DEPTH: usize = 24;

/// How strictly to check validator signatures during structure validation.
#[derive(Clone)]
pub enum TrustMode {
    /// Signatures must verify AND signers must be in the known-validator set
    /// (hub behavior, mirrors Python `verify_block_validator`).
    Registry {
        known: BTreeMap<String, ValidatorInfo>,
        quorum: usize,
    },
    /// Signatures must verify cryptographically; any consistent signer set is
    /// accepted (standalone verifier / light client behavior).
    CryptoOnly,
}

pub struct Chain {
    pub blocks: Vec<Block>,
    pub data_dir: PathBuf,
    pub max_reorg_depth: usize,
    pub allow_reset: bool,
    state_cache: Option<(usize, String, State)>,
}

impl Chain {
    /// Create a chain with a fresh genesis (treasury credited 1,000,000 MLC).
    pub fn new(data_dir: &Path) -> Self {
        let genesis = Self::genesis(data_dir);
        Chain {
            blocks: vec![genesis],
            data_dir: data_dir.to_path_buf(),
            max_reorg_depth: std::env::var("MAX_REORG_DEPTH")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_MAX_REORG_DEPTH),
            allow_reset: matches!(
                std::env::var("ALLOW_CHAIN_RESET").unwrap_or_default().to_lowercase().as_str(),
                "1" | "true" | "yes"
            ),
            state_cache: None,
        }
    }

    /// An empty probe chain used for validating candidate payloads.
    pub fn probe(data_dir: &Path, blocks: Vec<Block>) -> Self {
        Chain {
            blocks,
            data_dir: data_dir.to_path_buf(),
            max_reorg_depth: DEFAULT_MAX_REORG_DEPTH,
            allow_reset: false,
            state_cache: None,
        }
    }

    fn genesis(data_dir: &Path) -> Block {
        let treasury = Wallet::get_or_create(&data_dir.join("wallets"), "treasury");
        let transactions = vec![json!({
            "type": "credit",
            "to": treasury.address,
            "amount": 1000000.0,
            "reason": "Genesis MLC supply — network treasury",
            "timestamp": crate::now(),
        })];
        let (state, _) = apply_transactions(&State::new(), &transactions);
        let proof = json!({
            "chain_version": CHAIN_VERSION,
            "proof_type": PROOF_TYPE,
            "task_id": "genesis",
            "consensus": "MLC network genesis — useful inference replaces hash mining",
            "mlc_distributed": 0.0,
            "workers": [],
            "transactions": transactions,
            "state_root": state_root(&state),
        });
        let mut block = Block {
            index: 0,
            timestamp: crate::now(),
            data: "Genesis — Noetis Compute Lab inference chain".into(),
            previous_hash: "0".into(),
            proof,
            hash: String::new(),
        };
        let validators = Validators::open(data_dir, 0);
        seal(&mut block, &validators);
        block
    }

    pub fn from_payload(data_dir: &Path, payload: &[Value]) -> Option<Vec<Block>> {
        let _ = data_dir;
        payload.iter().map(Block::from_value).collect()
    }

    pub fn last_block(&self) -> &Block {
        self.blocks.last().expect("chain never empty")
    }

    pub fn len(&self) -> usize {
        self.blocks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }

    pub fn to_dicts(&self) -> Vec<Value> {
        self.blocks.iter().map(Block::to_dict).collect()
    }

    /// Current account state with an incremental cache.
    pub fn current_state(&mut self) -> State {
        let key = (self.blocks.len(), self.last_block().hash.clone());
        if let Some((len, hash, state)) = &self.state_cache {
            if *len == key.0 && *hash == key.1 {
                return state.clone();
            }
        }
        let state = rebuild_state_from_chain(&self.to_dicts());
        self.state_cache = Some((key.0, key.1, state.clone()));
        state
    }

    fn set_state_cache(&mut self, state: State) {
        let key = (self.blocks.len(), self.last_block().hash.clone());
        self.state_cache = Some((key.0, key.1, state));
    }

    /// Python `is_valid_structure`.
    pub fn is_valid_structure(&self, trust: &TrustMode, require_tip_quorum: bool) -> bool {
        if self.blocks.is_empty() {
            return false;
        }
        let genesis = &self.blocks[0];
        if genesis.index != 0 || genesis.previous_hash != "0" {
            return false;
        }
        if genesis.hash != genesis.compute_hash() {
            return false;
        }

        let last_index = self.blocks.len() - 1;
        for index in 1..self.blocks.len() {
            let current = &self.blocks[index];
            let previous = &self.blocks[index - 1];
            if current.index != previous.index + 1 {
                return false;
            }
            if current.previous_hash != previous.hash {
                return false;
            }
            if current.hash != current.compute_hash() {
                return false;
            }
            let proof = &current.proof;
            if proof.get("proof_type").and_then(Value::as_str) != Some(PROOF_TYPE) {
                return false;
            }
            let workers = proof.get("workers").and_then(Value::as_array).cloned().unwrap_or_default();
            if let Some(claimed) = proof.get("merkle_root").and_then(Value::as_str) {
                if !claimed.is_empty() && claimed != worker_rows_merkle_root(&workers) {
                    return false;
                }
            }
            let has_producer_sig = proof
                .get("validator_pubkey")
                .and_then(Value::as_str)
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            if has_producer_sig {
                match trust {
                    TrustMode::Registry { known, quorum } => {
                        let producer = proof.get("validator_pubkey").and_then(Value::as_str).unwrap_or("");
                        if !known.contains_key(producer) {
                            return false;
                        }
                        if !verify_block_signature(proof, &current.hash) {
                            return false;
                        }
                        if require_tip_quorum || index != last_index {
                            let required = (*quorum).clamp(1, known.len().max(1));
                            if signature_count(proof, &current.hash, Some(known)) < required {
                                return false;
                            }
                        }
                    }
                    TrustMode::CryptoOnly => {
                        if !verify_block_signature(proof, &current.hash) {
                            return false;
                        }
                    }
                }
            }
        }
        true
    }

    /// Python `is_valid_state` — replay all transactions and check state roots.
    pub fn is_valid_state(&self) -> bool {
        let mut state = State::new();
        for block in &self.blocks {
            let txs = block.transactions();
            let (next, errors) = apply_transactions(&state, &txs);
            if !errors.is_empty() {
                return false;
            }
            state = next;
            if let Some(claimed) = block.proof.get("state_root").and_then(Value::as_str) {
                if !claimed.is_empty() && claimed != state_root(&state) {
                    return false;
                }
            }
        }
        true
    }

    fn fork_depth(&self, payload: &[Value]) -> usize {
        let mut divergence = self.blocks.len();
        for (index, block) in self.blocks.iter().enumerate() {
            let matches = payload
                .get(index)
                .and_then(|item| item.get("hash"))
                .and_then(Value::as_str)
                == Some(block.hash.as_str());
            if !matches {
                divergence = index;
                break;
            }
        }
        self.blocks.len() - divergence
    }

    fn finality_error(&self, payload: &[Value]) -> Option<String> {
        if self.blocks.len() <= 1 || self.allow_reset {
            return None;
        }
        let payload_genesis = payload.first().and_then(|b| b.get("hash")).and_then(Value::as_str);
        if payload_genesis != Some(self.blocks[0].hash.as_str()) {
            return Some("Rejected: genesis mismatch (finality)".into());
        }
        let depth = self.fork_depth(payload);
        if depth > self.max_reorg_depth {
            return Some(format!(
                "Rejected: reorg depth {depth} exceeds finality limit {}",
                self.max_reorg_depth
            ));
        }
        None
    }

    /// Python `replace_chain` — validate + adopt or error.
    pub fn replace_chain(&mut self, payload: &[Value], trust: &TrustMode) -> Result<(), String> {
        if let Some(err) = self.finality_error(payload) {
            return Err(err);
        }
        let candidate = Chain::from_payload(&self.data_dir, payload).ok_or("Malformed blocks")?;
        let probe = Chain::probe(&self.data_dir, candidate);
        if !probe.is_valid_structure(trust, true) || !probe.is_valid_state() {
            return Err("Rejected invalid chain".into());
        }
        self.blocks = probe.blocks;
        self.state_cache = None;
        self.save();
        Ok(())
    }

    /// Python `merge_chain` — longest-chain with deterministic same-height tiebreak.
    pub fn merge_chain(&mut self, payload: &[Value], trust: &TrustMode, schedule_pubkeys: &[String]) -> Value {
        if payload.len() < self.blocks.len() || payload.is_empty() {
            return json!({"ok": true, "action": "noop", "length": self.blocks.len()});
        }

        if payload.len() == self.blocks.len() {
            let remote_tip = payload.last().and_then(|b| b.get("hash")).and_then(Value::as_str);
            if remote_tip == Some(self.last_block().hash.as_str()) {
                return json!({"ok": true, "action": "noop", "length": self.blocks.len()});
            }
            if self.blocks.len() == 1 {
                return self.replace_if_valid(payload, trust, "replaced");
            }
            if let Some(err) = self.finality_error(payload) {
                return json!({"ok": false, "error": err, "rejected": true});
            }
            let candidate_tip = payload.last().cloned().unwrap_or(Value::Null);
            let local_tip = self.last_block().to_dict();
            if !crate::schedule::tiebreak_wins(&candidate_tip, &local_tip, schedule_pubkeys) {
                return json!({
                    "ok": true, "action": "noop",
                    "reason": "local tip wins tiebreak",
                    "length": self.blocks.len(),
                });
            }
            return self.replace_if_valid(payload, trust, "fork_resolved");
        }

        if let Some(err) = self.finality_error(payload) {
            return json!({"ok": false, "error": err, "rejected": true});
        }
        self.replace_if_valid(payload, trust, "merged")
    }

    fn replace_if_valid(&mut self, payload: &[Value], trust: &TrustMode, action: &str) -> Value {
        let Some(candidate) = Chain::from_payload(&self.data_dir, payload) else {
            return json!({"ok": false, "error": "Rejected invalid chain", "rejected": true});
        };
        let probe = Chain::probe(&self.data_dir, candidate);
        if !probe.is_valid_structure(trust, true) || !probe.is_valid_state() {
            return json!({"ok": false, "error": "Rejected invalid chain", "rejected": true});
        }
        self.blocks = probe.blocks;
        self.state_cache = None;
        self.save();
        json!({"ok": true, "action": action, "length": self.blocks.len()})
    }

    /// Build, seal, cosign, and commit a state block (signed txs, faucet, …).
    /// `collect_cosignatures` is injected by the network layer.
    pub fn add_state_block(
        &mut self,
        transactions: Vec<Value>,
        data: &str,
        validators: &Validators,
        proposer: &str,
        collect_cosignatures: impl Fn(&Value) -> Vec<Value>,
        quorum_required: usize,
    ) -> Result<Block, String> {
        let prior_state = self.current_state();
        let mut clean = Vec::new();
        let mut rolling = prior_state;
        for tx in transactions {
            let (next, errors) = apply_transactions(&rolling, std::slice::from_ref(&tx));
            if errors.is_empty() {
                clean.push(tx);
                rolling = next;
            }
        }
        let proof = json!({
            "chain_version": CHAIN_VERSION,
            "proof_type": PROOF_TYPE,
            "task_id": "state",
            "proposer": proposer,
            "consensus": data,
            "mlc_distributed": 0.0,
            "workers": [],
            "transactions": clean,
            "state_root": state_root(&rolling),
        });
        let parent = self.last_block();
        let mut block = Block {
            index: parent.index + 1,
            timestamp: crate::now(),
            data: data.to_string(),
            previous_hash: parent.hash.clone(),
            proof,
            hash: String::new(),
        };
        seal(&mut block, validators);
        self.finalize_commit(block, rolling, validators, collect_cosignatures, quorum_required)
    }

    /// Build and commit an inference block from finalized task results.
    #[allow(clippy::too_many_arguments)]
    pub fn add_inference_block(
        &mut self,
        task_id: &str,
        prompt_hash: &str,
        consensus_hash: &str,
        worker_rows: Vec<Value>,
        transactions: Vec<Value>,
        workers_responded: usize,
        workers_matched: usize,
        winner: Option<String>,
        validators: &Validators,
        proposer: &str,
        collect_cosignatures: impl Fn(&Value) -> Vec<Value>,
        quorum_required: usize,
    ) -> Result<Block, String> {
        let prior_state = self.current_state();
        let mut clean = Vec::new();
        let mut rolling = prior_state;
        for tx in transactions {
            let (next, errors) = apply_transactions(&rolling, std::slice::from_ref(&tx));
            if errors.is_empty() {
                clean.push(tx);
                rolling = next;
            }
        }
        let mlc_total: f64 = round4(
            worker_rows
                .iter()
                .filter(|row| row.get("matched_consensus").and_then(Value::as_bool).unwrap_or(false))
                .filter_map(|row| row.get("reward").and_then(Value::as_f64))
                .sum(),
        );
        let proof = json!({
            "chain_version": CHAIN_VERSION,
            "proof_type": PROOF_TYPE,
            "task_id": task_id,
            "proposer": proposer,
            "decoding": {"temperature": 0.0, "seed": 42},
            "prompt_hash": prompt_hash,
            "consensus_hash": consensus_hash,
            "workers_responded": workers_responded,
            "workers_matched": workers_matched,
            "winner": winner,
            "mlc_distributed": mlc_total,
            "merkle_root": worker_rows_merkle_root(&worker_rows),
            "workers": worker_rows,
            "transactions": clean,
            "state_root": state_root(&rolling),
        });
        let parent = self.last_block();
        let mut block = Block {
            index: parent.index + 1,
            timestamp: crate::now(),
            data: format!("Inference task {task_id}"),
            previous_hash: parent.hash.clone(),
            proof,
            hash: String::new(),
        };
        seal(&mut block, validators);
        self.finalize_commit(block, rolling, validators, collect_cosignatures, quorum_required)
    }

    fn finalize_commit(
        &mut self,
        mut block: Block,
        next_state: State,
        _validators: &Validators,
        collect_cosignatures: impl Fn(&Value) -> Vec<Value>,
        quorum_required: usize,
    ) -> Result<Block, String> {
        let block_dict = block.to_dict();
        let cosignatures = collect_cosignatures(&block_dict);
        if !cosignatures.is_empty() {
            block.proof["cosignatures"] = Value::Array(cosignatures);
        }
        let sig_count = signature_count(&block.proof, &block.hash, None);
        if sig_count < quorum_required.max(1) {
            return Err("Insufficient validator cosignature quorum".into());
        }
        self.blocks.push(block.clone());
        self.set_state_cache(next_state);
        crate::store::append_block(&self.data_dir, &block.to_dict());
        Ok(block)
    }

    pub fn get_block(&self, index: i64) -> Option<Value> {
        self.blocks.iter().find(|b| b.index == index).map(Block::to_dict)
    }

    pub fn save(&self) {
        crate::store::replace_all(&self.data_dir, &self.to_dicts());
    }

    /// Load from SQLite; keep fresh genesis when the store is empty.
    pub fn load(&mut self, trust: &TrustMode) -> Result<(), String> {
        let payload = crate::store::load_blocks(&self.data_dir);
        if payload.is_empty() {
            self.save();
            return Ok(());
        }
        let blocks = Chain::from_payload(&self.data_dir, &payload).ok_or("Malformed stored chain")?;
        let genesis_version = blocks
            .first()
            .and_then(|b| b.proof.get("chain_version"))
            .and_then(Value::as_i64);
        if genesis_version != Some(CHAIN_VERSION) {
            self.save();
            return Ok(());
        }
        let probe = Chain::probe(&self.data_dir, blocks);
        if !probe.is_valid_structure(trust, true) || !probe.is_valid_state() {
            if self.allow_reset {
                self.save();
                return Ok(());
            }
            return Err("Stored chain failed validation — restart with ALLOW_CHAIN_RESET=1 to reset".into());
        }
        self.blocks = probe.blocks;
        self.state_cache = None;
        Ok(())
    }

    pub fn headers_snapshot(&self, trust: &TrustMode) -> Value {
        let headers: Vec<Value> = self
            .blocks
            .iter()
            .map(|block| {
                json!({
                    "index": block.index,
                    "hash": block.hash,
                    "previous_hash": block.previous_hash,
                    "timestamp": block.timestamp,
                    "state_root": block.proof.get("state_root").cloned().unwrap_or(Value::Null),
                    "validator_id": block.proof.get("validator_id").cloned().unwrap_or(Value::Null),
                    "cosignatures": block.proof.get("cosignatures").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0),
                })
            })
            .collect();
        json!({
            "length": headers.len(),
            "valid": self.is_valid_structure(trust, true) && self.is_valid_state(),
            "chain_version": CHAIN_VERSION,
            "finality_depth": self.max_reorg_depth,
            "headers": headers,
        })
    }

    pub fn snapshot(&mut self, trust: &TrustMode, full: bool) -> Value {
        let state = self.current_state();
        let blocks: Vec<Value> = if full {
            self.to_dicts()
        } else {
            self.blocks.iter().rev().take(12).map(Block::to_dict).collect()
        };
        json!({
            "length": self.blocks.len(),
            "valid": self.is_valid_structure(trust, true) && self.is_valid_state(),
            "token": "MLC",
            "proof_type": PROOF_TYPE,
            "chain_version": CHAIN_VERSION,
            "finality_depth": self.max_reorg_depth,
            "state_root": state_root(&state),
            "blocks": blocks,
        })
    }
}

/// Python `_seal_block` — compute hash, attach producer signature.
pub fn seal(block: &mut Block, validators: &Validators) {
    block.hash = block.compute_hash();
    let sig_fields = validators.sign_block_proof(&block.proof, &block.hash);
    if let (Some(proof), Some(fields)) = (block.proof.as_object_mut(), sig_fields.as_object()) {
        for (key, value) in fields {
            proof.insert(key.clone(), value.clone());
        }
    }
}
