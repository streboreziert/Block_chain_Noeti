//! Validator keys, federation registry, block signatures, and cosign quorum.
//!
//! Wire-compatible port of the Python `validators.py` + `consensus.py` signing
//! and verification logic. Networking (collecting cosignatures over HTTP) lives
//! in the `noetis-network` crate.

use crate::pyjson::dumps_canonical;
use crate::state::{on_chain_validators, State};
use crate::wallet::{verify_ed25519, Wallet};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const VALIDATOR_WALLET_NAME: &str = "hub-validator";

#[derive(Debug, Clone, Default)]
pub struct ValidatorInfo {
    pub validator_id: String,
    pub public_key: String,
    pub address: String,
    pub hub_url: String,
}

impl ValidatorInfo {
    pub fn to_dict(&self) -> Value {
        json!({
            "validator_id": self.validator_id,
            "public_key": self.public_key,
            "address": self.address,
            "hub_url": self.hub_url,
        })
    }
}

/// Validator identity + federation registry, persisted in the data directory
/// (`wallets/hub-validator.json`, `validator.json`, `federation.json`).
pub struct Validators {
    pub data_dir: PathBuf,
    pub wallet: Wallet,
    pub hub_url: String,
    pub quorum_env: usize,
}

impl Validators {
    pub fn open(data_dir: &Path, quorum_env: usize) -> Self {
        let wallet_dir = data_dir.join("wallets");
        let wallet = Wallet::get_or_create(&wallet_dir, VALIDATOR_WALLET_NAME);
        let validator_path = data_dir.join("validator.json");
        let hub_url = fs::read_to_string(&validator_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.get("hub_url").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        let me = Validators {
            data_dir: data_dir.to_path_buf(),
            wallet,
            hub_url,
            quorum_env,
        };
        me.write_validator_meta();
        me
    }

    fn validator_path(&self) -> PathBuf {
        self.data_dir.join("validator.json")
    }

    fn federation_path(&self) -> PathBuf {
        self.data_dir.join("federation.json")
    }

    fn write_validator_meta(&self) {
        let meta = json!({
            "validator_id": self.wallet.name,
            "public_key": self.wallet.public_key_hex,
            "address": self.wallet.address,
            "hub_url": self.hub_url,
        });
        let _ = fs::create_dir_all(&self.data_dir);
        let _ = fs::write(self.validator_path(), serde_json::to_string_pretty(&meta).unwrap());
    }

    pub fn set_hub_url(&mut self, hub_url: &str) {
        self.hub_url = hub_url.trim_end_matches('/').to_string();
        self.write_validator_meta();
    }

    pub fn info(&self) -> ValidatorInfo {
        ValidatorInfo {
            validator_id: self.wallet.name.clone(),
            public_key: self.wallet.public_key_hex.clone(),
            address: self.wallet.address.clone(),
            hub_url: self.hub_url.clone(),
        }
    }

    fn load_federation(&self) -> Map<String, Value> {
        fs::read_to_string(self.federation_path())
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.get("validators").and_then(Value::as_object).cloned())
            .unwrap_or_default()
    }

    fn save_federation(&self, validators: &Map<String, Value>) {
        let store = json!({ "validators": validators });
        let _ = fs::create_dir_all(&self.data_dir);
        let _ = fs::write(self.federation_path(), serde_json::to_string_pretty(&store).unwrap());
    }

    /// Bootstrap-trusted set (local + federation.json). Governs quorum size.
    pub fn registry_validators(&self) -> BTreeMap<String, ValidatorInfo> {
        let mut validators = BTreeMap::new();
        let local = self.info();
        validators.insert(local.public_key.clone(), local);
        for entry in self.load_federation().values() {
            let info = ValidatorInfo {
                validator_id: entry.get("validator_id").and_then(Value::as_str).unwrap_or("").into(),
                public_key: entry.get("public_key").and_then(Value::as_str).unwrap_or("").into(),
                address: entry.get("address").and_then(Value::as_str).unwrap_or("").into(),
                hub_url: entry.get("hub_url").and_then(Value::as_str).unwrap_or("").into(),
            };
            if !info.public_key.is_empty() {
                validators.insert(info.public_key.clone(), info);
            }
        }
        validators
    }

    /// Registry plus stake-backed on-chain validators. Recognized for block
    /// signatures and the proposer schedule, but does NOT raise the quorum.
    pub fn known_validators(&self, state: &State) -> BTreeMap<String, ValidatorInfo> {
        let mut validators = self.registry_validators();
        for entry in on_chain_validators(state) {
            let info = ValidatorInfo {
                validator_id: entry.get("validator_id").and_then(Value::as_str).unwrap_or("").into(),
                public_key: entry.get("public_key").and_then(Value::as_str).unwrap_or("").into(),
                address: entry.get("address").and_then(Value::as_str).unwrap_or("").into(),
                hub_url: entry.get("hub_url").and_then(Value::as_str).unwrap_or("").into(),
            };
            if !info.public_key.is_empty() {
                validators.entry(info.public_key.clone()).or_insert(info);
            }
        }
        validators
    }

    pub fn effective_quorum(&self) -> usize {
        if self.quorum_env > 0 {
            return self.quorum_env;
        }
        if self.registry_validators().len() >= 2 {
            2
        } else {
            1
        }
    }

    /// Python `sign_block_proof` — producer signature fields for a sealed block.
    pub fn sign_block_proof(&self, proof: &Value, block_hash: &str) -> Value {
        let payload = signature_payload(proof, block_hash, &self.wallet.name, &self.wallet.public_key_hex);
        let signature = self.wallet.sign_payload(&payload);
        json!({
            "validator_id": self.wallet.name,
            "validator_pubkey": self.wallet.public_key_hex,
            "validator_signature": signature,
        })
    }

    /// Python `make_cosignature`.
    pub fn make_cosignature(&self, proof: &Value, block_hash: &str) -> Value {
        self.sign_block_proof(proof, block_hash)
    }

    /// Register a federation peer after verifying its Ed25519 registration signature.
    pub fn register_peer(
        &self,
        hub_url: &str,
        validator_id: &str,
        public_key: &str,
        address: &str,
        signature: &str,
        timestamp: f64,
    ) -> Result<Value, String> {
        let mut signed: Map<String, Value> = Map::new();
        signed.insert("hub_url".into(), json!(hub_url));
        signed.insert("validator_id".into(), json!(validator_id));
        signed.insert("public_key".into(), json!(public_key));
        signed.insert("address".into(), json!(address));
        signed.insert("timestamp".into(), json!(timestamp));
        signed.insert("from".into(), json!(address));
        signed.insert("signature".into(), json!(signature));
        if !crate::wallet::verify_signature(&Value::Object(signed)) {
            return Err("Invalid validator registration signature".into());
        }

        let mut store = self.load_federation();
        store.insert(
            public_key.to_string(),
            json!({
                "hub_url": hub_url,
                "validator_id": validator_id,
                "public_key": public_key,
                "address": address,
                "timestamp": timestamp,
                "registered_at": crate::now(),
            }),
        );
        self.save_federation(&store);
        Ok(json!({"ok": true, "validator_id": validator_id, "hub_url": hub_url}))
    }

    /// Trust-on-bootstrap import of a peer validator (Python `register_peer_trusted`).
    pub fn register_peer_trusted(&self, hub_url: &str, validator_id: &str, public_key: &str, address: &str) -> Value {
        let mut store = self.load_federation();
        store.insert(
            public_key.to_string(),
            json!({
                "hub_url": hub_url,
                "validator_id": validator_id,
                "public_key": public_key,
                "address": address,
                "registered_at": crate::now(),
                "trusted_bootstrap": true,
            }),
        );
        self.save_federation(&store);
        json!({"ok": true, "validator_id": validator_id, "hub_url": hub_url, "trusted": true})
    }
}

/// The canonical payload covered by block producer signatures and cosignatures.
pub fn signature_payload(proof: &Value, block_hash: &str, validator_id: &str, public_key: &str) -> Value {
    json!({
        "block_hash": block_hash,
        "state_root": proof.get("state_root").cloned().unwrap_or(Value::Null),
        "task_id": proof.get("task_id").cloned().unwrap_or(Value::Null),
        "validator_id": validator_id,
        "public_key": public_key,
    })
}

/// Cryptographic verification of the producer signature (no registry check).
pub fn verify_block_signature(proof: &Value, block_hash: &str) -> bool {
    let pubkey = proof.get("validator_pubkey").and_then(Value::as_str).unwrap_or("");
    let signature = proof.get("validator_signature").and_then(Value::as_str).unwrap_or("");
    if pubkey.is_empty() || signature.is_empty() {
        return false;
    }
    let validator_id = proof.get("validator_id").cloned().unwrap_or(Value::Null);
    let payload = json!({
        "block_hash": block_hash,
        "state_root": proof.get("state_root").cloned().unwrap_or(Value::Null),
        "task_id": proof.get("task_id").cloned().unwrap_or(Value::Null),
        "validator_id": validator_id,
        "public_key": pubkey,
    });
    verify_ed25519(pubkey, signature, dumps_canonical(&payload).as_bytes())
}

/// Cryptographic verification of one cosignature entry.
pub fn verify_cosignature_crypto(cosign: &Value, proof: &Value, block_hash: &str) -> bool {
    let pubkey = cosign.get("validator_pubkey").and_then(Value::as_str).unwrap_or("");
    let signature = cosign.get("validator_signature").and_then(Value::as_str).unwrap_or("");
    if pubkey.is_empty() || signature.is_empty() {
        return false;
    }
    let payload = signature_payload(
        proof,
        block_hash,
        cosign.get("validator_id").and_then(Value::as_str).unwrap_or(""),
        pubkey,
    );
    verify_ed25519(pubkey, signature, dumps_canonical(&payload).as_bytes())
}

/// Count distinct valid signatures (producer + cosignatures), optionally
/// restricted to a known-validator set.
pub fn signature_count(proof: &Value, block_hash: &str, known: Option<&BTreeMap<String, ValidatorInfo>>) -> usize {
    let mut count = 0;
    let mut seen: Vec<String> = Vec::new();
    let producer_pub = proof.get("validator_pubkey").and_then(Value::as_str).unwrap_or("").to_string();
    let producer_known = known.map(|k| k.contains_key(&producer_pub)).unwrap_or(true);
    if producer_known && verify_block_signature(proof, block_hash) {
        count += 1;
    }
    seen.push(producer_pub);
    for cosign in proof.get("cosignatures").and_then(Value::as_array).cloned().unwrap_or_default() {
        let pubkey = cosign.get("validator_pubkey").and_then(Value::as_str).unwrap_or("").to_string();
        if seen.contains(&pubkey) {
            continue;
        }
        let cosigner_known = known.map(|k| k.contains_key(&pubkey)).unwrap_or(true);
        if cosigner_known && verify_cosignature_crypto(&cosign, proof, block_hash) {
            count += 1;
            seen.push(pubkey);
        }
    }
    count
}
