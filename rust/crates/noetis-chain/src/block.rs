//! Block structure and hashing — byte-compatible with Python `inference_chain.py`.

use crate::pyjson::{dumps_sorted, sha256_text};
use serde_json::{json, Map, Value};

pub const PROOF_TYPE: &str = "proof_of_inference";
pub const CHAIN_VERSION: i64 = 4;
pub const VALIDATOR_FIELDS: [&str; 3] = ["validator_id", "validator_pubkey", "validator_signature"];

#[derive(Debug, Clone)]
pub struct Block {
    pub index: i64,
    pub timestamp: f64,
    pub data: String,
    pub previous_hash: String,
    pub proof: Value,
    pub hash: String,
}

impl Block {
    pub fn from_value(item: &Value) -> Option<Block> {
        Some(Block {
            index: item.get("index")?.as_i64()?,
            timestamp: item.get("timestamp")?.as_f64()?,
            data: item.get("data")?.as_str()?.to_string(),
            previous_hash: item.get("previous_hash")?.as_str()?.to_string(),
            proof: item.get("proof").cloned().unwrap_or_else(|| json!({})),
            hash: item.get("hash").and_then(Value::as_str).unwrap_or("").to_string(),
        })
    }

    /// Python `Block.to_dict` — includes the cosmetic `time` and `hash_short`
    /// fields (excluded from the hash payload).
    pub fn to_dict(&self) -> Value {
        let time_str = format_local_time(self.timestamp);
        let hash_short = if self.hash.is_empty() {
            String::new()
        } else {
            format!("{}\u{2026}{}", &self.hash[..10], &self.hash[self.hash.len() - 6..])
        };
        json!({
            "index": self.index,
            "timestamp": self.timestamp,
            "time": time_str,
            "data": self.data,
            "previous_hash": self.previous_hash,
            "proof": self.proof,
            "hash": self.hash,
            "hash_short": hash_short,
        })
    }

    /// Proof with producer signature fields and cosignatures stripped —
    /// the part covered by the block hash.
    pub fn proof_for_hash(&self) -> Value {
        let mut trimmed: Map<String, Value> = self.proof.as_object().cloned().unwrap_or_default();
        for key in VALIDATOR_FIELDS {
            trimmed.remove(key);
        }
        trimmed.remove("cosignatures");
        Value::Object(trimmed)
    }

    /// Python `InferenceBlockchain._hash`.
    pub fn compute_hash(&self) -> String {
        let payload = json!({
            "index": self.index,
            "timestamp": self.timestamp,
            "data": self.data,
            "previous_hash": self.previous_hash,
            "proof": self.proof_for_hash(),
        });
        sha256_text(&dumps_sorted(&payload))
    }

    pub fn transactions(&self) -> Vec<Value> {
        self.proof
            .get("transactions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }
}

fn format_local_time(timestamp: f64) -> String {
    use chrono::TimeZone;
    let secs = timestamp as i64;
    let nanos = ((timestamp - secs as f64) * 1e9) as u32;
    match chrono::Local.timestamp_opt(secs, nanos) {
        chrono::LocalResult::Single(dt) => dt.format("%Y-%m-%d %H:%M:%S").to_string(),
        _ => String::new(),
    }
}

/// Python `InferenceBlockchain._merkle_root` — Merkle root over serialized
/// worker rows (hex-string concatenation hashing).
pub fn merkle_root(items: &[String]) -> String {
    if items.is_empty() {
        return sha256_text("");
    }
    let mut layer: Vec<String> = items.iter().map(|item| sha256_text(item)).collect();
    while layer.len() > 1 {
        if layer.len() % 2 == 1 {
            layer.push(layer[layer.len() - 1].clone());
        }
        layer = layer
            .chunks(2)
            .map(|pair| sha256_text(&format!("{}{}", pair[0], pair[1])))
            .collect();
    }
    layer[0].clone()
}

pub fn worker_rows_merkle_root(workers: &[Value]) -> String {
    let items: Vec<String> = workers.iter().map(dumps_sorted).collect();
    merkle_root(&items)
}
