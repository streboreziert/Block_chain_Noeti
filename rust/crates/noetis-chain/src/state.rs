//! On-chain MLC account state — port of the Python `chain_state` module.

use crate::pyjson::round6;
use crate::wallet::verify_signature;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const TOKEN_SYMBOL: &str = "MLC";
pub const MIN_STAKE: f64 = 10.0;
pub const VALIDATOR_MIN_STAKE: f64 = 100.0;
pub const SLASH_AMOUNT: f64 = 1.0;
pub const SIGNED_TYPES: [&str; 4] = ["transfer", "stake", "unstake", "validator_register"];
pub const SYSTEM_TYPES: [&str; 2] = ["credit", "slash"];

/// One account row. `validator` is kept as raw JSON to preserve leaf hashes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Account {
    pub balance: f64,
    pub nonce: i64,
    pub staked: f64,
    pub node_id: Option<String>,
    pub validator: Option<Value>,
}

/// Address → account. BTreeMap gives the sorted-address ordering the
/// Python code gets from `sorted(state)`.
pub type State = BTreeMap<String, Account>;

pub fn is_signed_type(tx_type: &str) -> bool {
    SIGNED_TYPES.contains(&tx_type)
}

pub fn is_known_type(tx_type: &str) -> bool {
    SIGNED_TYPES.contains(&tx_type) || SYSTEM_TYPES.contains(&tx_type)
}

fn tx_str(tx: &Value, key: &str) -> String {
    match tx.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn tx_amount(tx: &Value) -> f64 {
    round6(tx.get("amount").and_then(Value::as_f64).unwrap_or(0.0))
}

fn account<'a>(state: &'a mut State, address: &str) -> &'a mut Account {
    state.entry(address.to_string()).or_default()
}

/// Python `validate_transaction` — returns Some(error) when invalid.
pub fn validate_transaction(tx: &Value, state: &mut State) -> Option<String> {
    let tx_type = tx_str(tx, "type");
    let amount = tx_amount(tx);
    if !is_known_type(&tx_type) {
        return Some(format!("Unknown transaction type: {tx_type}"));
    }

    if is_signed_type(&tx_type) {
        if !verify_signature(tx) {
            return Some("Invalid signature".into());
        }
        let from = tx_str(tx, "from");
        let expected_nonce = account(state, &from).nonce;
        let nonce = tx.get("nonce").and_then(Value::as_i64).unwrap_or(-1);
        if nonce != expected_nonce {
            return Some(format!("Invalid nonce — expected {expected_nonce}, got {nonce}"));
        }
        if amount <= 0.0 && tx_type != "validator_register" {
            return Some("Amount must be positive".into());
        }
    }

    match tx_type.as_str() {
        "transfer" => {
            let from = tx_str(tx, "from");
            if account(state, &from).balance < amount {
                return Some("Insufficient balance".into());
            }
            if tx_str(tx, "to") == from {
                return Some("Cannot transfer to self".into());
            }
        }
        "stake" => {
            let from = tx_str(tx, "from");
            if account(state, &from).balance < amount {
                return Some("Insufficient balance to stake".into());
            }
            if amount < MIN_STAKE {
                return Some(format!("Minimum stake is {MIN_STAKE} MLC"));
            }
            if tx_str(tx, "node_id").trim().is_empty() {
                return Some("node_id required for stake".into());
            }
        }
        "unstake" => {
            let from = tx_str(tx, "from");
            if account(state, &from).staked < amount {
                return Some("Insufficient staked balance".into());
            }
        }
        "credit" => {
            if amount <= 0.0 {
                return Some("Credit amount must be positive".into());
            }
            if tx_str(tx, "to").trim().is_empty() {
                return Some("Credit requires recipient".into());
            }
        }
        "slash" => {
            if amount <= 0.0 {
                return Some("Slash amount must be positive".into());
            }
            if tx_str(tx, "from").trim().is_empty() {
                return Some("Slash requires source address".into());
            }
        }
        "validator_register" => {
            let from = tx_str(tx, "from");
            if tx_str(tx, "validator_id").trim().is_empty() {
                return Some("validator_id required".into());
            }
            if tx_str(tx, "hub_url").trim().is_empty() {
                return Some("hub_url required".into());
            }
            let staked = account(state, &from).staked;
            if staked < VALIDATOR_MIN_STAKE {
                return Some(format!(
                    "Validators must stake at least {VALIDATOR_MIN_STAKE} MLC (staked: {staked})"
                ));
            }
        }
        _ => {}
    }
    None
}

/// Python `apply_transaction` — mutates state; caller must validate first.
pub fn apply_transaction(state: &mut State, tx: &Value) {
    let tx_type = tx_str(tx, "type");
    let amount = tx_amount(tx);

    match tx_type.as_str() {
        "credit" => {
            let to = tx_str(tx, "to");
            let recipient = account(state, &to);
            recipient.balance = round6(recipient.balance + amount);
        }
        "transfer" => {
            let from = tx_str(tx, "from");
            let to = tx_str(tx, "to");
            {
                let sender = account(state, &from);
                sender.balance = round6(sender.balance - amount);
                sender.nonce += 1;
            }
            let recipient = account(state, &to);
            recipient.balance = round6(recipient.balance + amount);
        }
        "stake" => {
            let from = tx_str(tx, "from");
            let sender = account(state, &from);
            sender.balance = round6(sender.balance - amount);
            sender.staked = round6(sender.staked + amount);
            sender.node_id = Some(tx_str(tx, "node_id"));
            sender.nonce += 1;
        }
        "unstake" => {
            let from = tx_str(tx, "from");
            let sender = account(state, &from);
            sender.staked = round6(sender.staked - amount);
            sender.balance = round6(sender.balance + amount);
            if sender.staked <= 0.0 {
                sender.node_id = None;
            }
            sender.nonce += 1;
        }
        "slash" => {
            let from = tx_str(tx, "from");
            let source = account(state, &from);
            let mut remaining = amount;
            let from_staked = source.staked.min(remaining);
            source.staked = round6(source.staked - from_staked);
            remaining = round6(remaining - from_staked);
            if remaining > 0.0 {
                let from_balance = source.balance.min(remaining);
                source.balance = round6(source.balance - from_balance);
            }
            if source.staked < MIN_STAKE {
                source.node_id = None;
            }
        }
        "validator_register" => {
            let from = tx_str(tx, "from");
            let registered_at = tx
                .get("timestamp")
                .and_then(Value::as_f64)
                .unwrap_or_else(crate::now);
            let sender = account(state, &from);
            sender.validator = Some(json!({
                "validator_id": tx_str(tx, "validator_id"),
                "public_key": tx_str(tx, "public_key"),
                "hub_url": tx_str(tx, "hub_url"),
                "registered_at": registered_at,
            }));
            sender.nonce += 1;
        }
        _ => {}
    }
}

/// Python `apply_transactions` — returns (next_state, errors).
pub fn apply_transactions(state: &State, transactions: &[Value]) -> (State, Vec<String>) {
    let mut next = state.clone();
    let mut errors = Vec::new();
    for tx in transactions {
        if let Some(error) = validate_transaction(tx, &mut next) {
            errors.push(error);
            continue;
        }
        apply_transaction(&mut next, tx);
    }
    (next, errors)
}

pub fn rebuild_state_from_chain(blocks: &[Value]) -> State {
    let mut state = State::new();
    for block in blocks {
        let txs = block
            .get("proof")
            .and_then(|p| p.get("transactions"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let (next, _) = apply_transactions(&state, &txs);
        state = next;
    }
    state
}

pub fn credit_tx(to_address: &str, amount: f64, reason: &str, worker_id: &str, task_id: &str) -> Value {
    json!({
        "type": "credit",
        "to": to_address,
        "amount": round6(amount),
        "reason": reason,
        "worker_id": worker_id,
        "task_id": task_id,
        "timestamp": crate::now(),
    })
}

pub fn slash_tx(from_address: &str, amount: f64, node_id: &str, reason: &str, task_id: &str) -> Value {
    json!({
        "type": "slash",
        "from": from_address,
        "amount": round6(amount),
        "node_id": node_id,
        "reason": reason,
        "task_id": task_id,
        "timestamp": crate::now(),
    })
}

pub fn get_balance(state: &State, address: &str) -> Value {
    let row = state.get(address).cloned().unwrap_or_default();
    json!({
        "address": address,
        "balance": round6(row.balance),
        "staked": round6(row.staked),
        "nonce": row.nonce,
        "node_id": row.node_id,
        "total": round6(row.balance + row.staked),
    })
}

pub fn list_balances(state: &State) -> Vec<Value> {
    let mut rows: Vec<Value> = state.keys().map(|addr| get_balance(state, addr)).collect();
    rows.sort_by(|a, b| {
        let ta = a.get("total").and_then(Value::as_f64).unwrap_or(0.0);
        let tb = b.get("total").and_then(Value::as_f64).unwrap_or(0.0);
        tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

pub fn has_minimum_stake(state: &State, address: &str, node_id: &str) -> bool {
    match state.get(address) {
        Some(row) => row.staked >= MIN_STAKE && row.node_id.as_deref() == Some(node_id),
        None => false,
    }
}

/// Validators registered on-chain with stake still locked.
pub fn on_chain_validators(state: &State) -> Vec<Value> {
    let mut rows = Vec::new();
    for (address, row) in state {
        let Some(info) = &row.validator else { continue };
        if row.staked < VALIDATOR_MIN_STAKE {
            continue;
        }
        let mut merged: Map<String, Value> = info.as_object().cloned().unwrap_or_default();
        merged.insert("address".into(), Value::String(address.clone()));
        merged.insert("staked".into(), json!(row.staked));
        rows.push(Value::Object(merged));
    }
    rows
}
