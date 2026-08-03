//! Deterministic block proposer schedule — port of Python `schedule.py`.

use serde_json::Value;

/// Proposer for height H is `sorted_pubkeys[H % N]`.
pub fn proposer_pubkey_for_height(height: i64, sorted_pubkeys: &[String]) -> String {
    if sorted_pubkeys.is_empty() {
        return String::new();
    }
    let index = (height.rem_euclid(sorted_pubkeys.len() as i64)) as usize;
    sorted_pubkeys[index].clone()
}

pub fn is_local_turn(height: i64, sorted_pubkeys: &[String], local_pubkey: &str) -> bool {
    let scheduled = proposer_pubkey_for_height(height, sorted_pubkeys);
    scheduled.is_empty() || scheduled == local_pubkey
}

/// Python `tiebreak_wins` — candidate beats local tip at equal height when it
/// was sealed by the scheduled proposer (falling back to lower hash).
pub fn tiebreak_wins(candidate_tip: &Value, local_tip: &Value, sorted_pubkeys: &[String]) -> bool {
    let height = candidate_tip.get("index").and_then(Value::as_i64).unwrap_or(0);
    let scheduled = proposer_pubkey_for_height(height, sorted_pubkeys);
    let cand_signer = candidate_tip
        .get("proof")
        .and_then(|p| p.get("validator_pubkey"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let local_signer = local_tip
        .get("proof")
        .and_then(|p| p.get("validator_pubkey"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !scheduled.is_empty() {
        if cand_signer == scheduled && local_signer != scheduled {
            return true;
        }
        if local_signer == scheduled && cand_signer != scheduled {
            return false;
        }
    }
    let cand_hash = candidate_tip.get("hash").and_then(Value::as_str).unwrap_or("");
    let local_hash = local_tip.get("hash").and_then(Value::as_str).unwrap_or("");
    cand_hash < local_hash
}
