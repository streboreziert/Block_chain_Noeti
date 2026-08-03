//! SPV account proofs — Merkle state roots, byte-compatible with Python `spv.py`.

use crate::pyjson::{dumps_sorted, round6, sha256_text};
use crate::state::{Account, State};
use serde_json::{json, Map, Value};

/// Python `account_row` — the JSON leaf payload for one account.
pub fn account_row(address: &str, row: &Account) -> Value {
    let mut payload = Map::new();
    payload.insert("address".into(), json!(address));
    payload.insert("balance".into(), json!(round6(row.balance)));
    payload.insert("nonce".into(), json!(row.nonce));
    payload.insert("staked".into(), json!(round6(row.staked)));
    payload.insert("node_id".into(), json!(row.node_id));
    if let Some(validator) = &row.validator {
        if !validator.is_null() {
            payload.insert("validator".into(), validator.clone());
        }
    }
    Value::Object(payload)
}

pub fn leaf_hash(address: &str, row: &Account) -> String {
    sha256_text(&dumps_sorted(&account_row(address, row)))
}

fn merkle_layer(hashes: &[String]) -> Vec<String> {
    if hashes.is_empty() {
        return vec![sha256_text("")];
    }
    if hashes.len() == 1 {
        return hashes.to_vec();
    }
    let mut layer = Vec::new();
    let mut index = 0;
    while index < hashes.len() {
        let left = &hashes[index];
        let right = if index + 1 < hashes.len() { &hashes[index + 1] } else { left };
        layer.push(sha256_text(&format!("{left}{right}")));
        index += 2;
    }
    layer
}

pub fn merkle_root_from_state(state: &State) -> String {
    if state.is_empty() {
        return sha256_text("");
    }
    let mut layer: Vec<String> = state.iter().map(|(addr, row)| leaf_hash(addr, row)).collect();
    while layer.len() > 1 {
        layer = merkle_layer(&layer);
    }
    layer[0].clone()
}

pub fn state_root(state: &State) -> String {
    merkle_root_from_state(state)
}

fn build_merkle_tree(state: &State) -> (Vec<String>, Vec<Vec<String>>) {
    let leaves: Vec<String> = state.iter().map(|(addr, row)| leaf_hash(addr, row)).collect();
    if leaves.is_empty() {
        return (vec![], vec![vec![sha256_text("")]]);
    }
    let mut levels = vec![leaves.clone()];
    let mut layer = leaves.clone();
    while layer.len() > 1 {
        layer = merkle_layer(&layer);
        levels.push(layer.clone());
    }
    (leaves, levels)
}

/// Python `account_proof` — Merkle inclusion proof for one address.
pub fn account_proof(state: &State, address: &str) -> Option<Value> {
    if !state.contains_key(address) {
        return None;
    }
    let (leaves, levels) = build_merkle_tree(state);
    let index = state.keys().position(|key| key == address)?;

    let mut siblings = Vec::new();
    let mut pos = index;
    for level in &levels[..levels.len() - 1] {
        let pair_index = pos ^ 1;
        if pair_index < level.len() {
            siblings.push(json!({
                "hash": level[pair_index],
                "position": if pos % 2 == 0 { "right" } else { "left" },
            }));
        } else {
            siblings.push(json!({"hash": level[pos], "position": "right"}));
        }
        pos /= 2;
    }

    Some(json!({
        "address": address,
        "account": account_row(address, &state[address]),
        "leaf": leaves[index],
        "siblings": siblings,
        "state_root": levels[levels.len() - 1][0],
    }))
}

/// Python `verify_account_proof` — recompute the leaf from the account row
/// (re-normalized through `account_row`, exactly like the Python code).
pub fn verify_account_proof(proof: &Value) -> bool {
    let address = proof.get("address").and_then(Value::as_str).unwrap_or("");
    let Some(account_value) = proof.get("account") else { return false };
    let row = Account {
        balance: account_value.get("balance").and_then(Value::as_f64).unwrap_or(0.0),
        nonce: account_value.get("nonce").and_then(Value::as_i64).unwrap_or(0),
        staked: account_value.get("staked").and_then(Value::as_f64).unwrap_or(0.0),
        node_id: account_value
            .get("node_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        validator: account_value.get("validator").filter(|v| !v.is_null()).cloned(),
    };
    let expected_leaf = leaf_hash(address, &row);
    if proof.get("leaf").and_then(Value::as_str) != Some(expected_leaf.as_str()) {
        return false;
    }
    let mut current = expected_leaf;
    for step in proof.get("siblings").and_then(Value::as_array).cloned().unwrap_or_default() {
        let sibling = step.get("hash").and_then(Value::as_str).unwrap_or("").to_string();
        current = if step.get("position").and_then(Value::as_str) == Some("left") {
            sha256_text(&format!("{sibling}{current}"))
        } else {
            sha256_text(&format!("{current}{sibling}"))
        };
    }
    proof.get("state_root").and_then(Value::as_str) == Some(current.as_str())
}
