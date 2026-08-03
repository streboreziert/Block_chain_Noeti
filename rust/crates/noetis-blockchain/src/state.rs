use noetis_protocol::{Transaction, TransactionType};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct ChainAccountState {
    pub balances: HashMap<String, f64>,
    pub escrows: HashMap<String, EscrowEntry>,
}

#[derive(Debug, Clone)]
pub struct EscrowEntry {
    pub user: String,
    pub amount: f64,
}

pub fn create_account_state() -> ChainAccountState {
    ChainAccountState::default()
}

pub fn get_balance(state: &ChainAccountState, address: &str) -> f64 {
    *state.balances.get(address).unwrap_or(&0.0)
}

fn credit(state: &mut ChainAccountState, to: &str, amount: f64) {
    state
        .balances
        .insert(to.to_string(), get_balance(state, to) + amount);
}

fn debit(state: &mut ChainAccountState, from: &str, amount: f64) -> bool {
    let bal = get_balance(state, from);
    if bal < amount {
        return false;
    }
    state.balances.insert(from.to_string(), bal - amount);
    true
}

fn metadata_task_id(metadata: &HashMap<String, Value>) -> Option<String> {
    metadata
        .get("task_id")
        .or_else(|| metadata.get("taskId"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

pub fn apply_transaction(state: &mut ChainAccountState, tx: &Transaction) -> bool {
    match tx.tx_type {
        TransactionType::WalletCreated => {
            if let Some(ref to) = tx.to {
                state.balances.entry(to.clone()).or_insert(0.0);
            }
            true
        }
        TransactionType::FaucetTransfer => {
            if let Some(ref to) = tx.to {
                credit(state, to, tx.amount);
            }
            true
        }
        TransactionType::CurrencyTransfer => {
            let (Some(ref from), Some(ref to)) = (&tx.from, &tx.to) else {
                return false;
            };
            if !debit(state, from, tx.amount) {
                return false;
            }
            credit(state, to, tx.amount);
            true
        }
        TransactionType::TaskFunded => {
            let task_id = metadata_task_id(&tx.metadata);
            let (Some(ref from), Some(task_id)) = (&tx.from, task_id) else {
                return false;
            };
            if !debit(state, from, tx.amount) {
                return false;
            }
            state.escrows.insert(
                task_id,
                EscrowEntry {
                    user: from.clone(),
                    amount: tx.amount,
                },
            );
            true
        }
        TransactionType::TaskPaid | TransactionType::TaskRefunded => {
            if let Some(ref to) = tx.to {
                credit(state, to, tx.amount);
            }
            true
        }
        TransactionType::NodeStaked => {
            if let Some(ref from) = tx.from {
                return debit(state, from, tx.amount);
            }
            false
        }
        TransactionType::NodePenalized => {
            if let Some(ref from) = tx.from {
                let amount = tx.amount.min(get_balance(state, from));
                debit(state, from, amount);
            }
            true
        }
        _ => true,
    }
}

pub fn apply_block_transactions(state: &mut ChainAccountState, transactions: &[Transaction]) -> bool {
    for tx in transactions {
        if !apply_transaction(state, tx) {
            return false;
        }
    }
    true
}

pub fn derive_state_from_chain(block_transactions: &[Vec<Transaction>]) -> ChainAccountState {
    let mut state = create_account_state();
    for block_txs in block_transactions {
        apply_block_transactions(&mut state, block_txs);
    }
    state
}
