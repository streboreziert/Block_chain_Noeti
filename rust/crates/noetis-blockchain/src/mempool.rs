use noetis_protocol::{Transaction, TransactionType};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub struct Mempool {
    txs: HashMap<String, Transaction>,
    seen: HashSet<String>,
}

impl Default for Mempool {
    fn default() -> Self {
        Self::new()
    }
}

impl Mempool {
    pub fn new() -> Self {
        Self {
            txs: HashMap::new(),
            seen: HashSet::new(),
        }
    }

    pub fn add(&mut self, tx: Transaction) -> bool {
        let key = if tx.id.is_empty() {
            format!(
                "{:?}:{}:{}",
                tx.tx_type,
                tx.from.as_deref().unwrap_or(""),
                tx.timestamp
            )
        } else {
            tx.id.clone()
        };
        if self.seen.contains(&key) {
            return false;
        }
        self.seen.insert(key);
        self.txs.insert(tx.id.clone(), tx);
        true
    }

    pub fn list(&self) -> Vec<Transaction> {
        let mut txs: Vec<Transaction> = self.txs.values().cloned().collect();
        txs.sort_by_key(|t| t.timestamp);
        txs
    }

    pub fn drain(&mut self) -> Vec<Transaction> {
        let all = self.list();
        self.txs.clear();
        all
    }

    pub fn remove(&mut self, ids: &[String]) {
        for id in ids {
            self.txs.remove(id);
        }
    }

    pub fn size(&self) -> usize {
        self.txs.len()
    }
}

pub fn create_tx(
    tx_type: TransactionType,
    from: Option<&str>,
    to: Option<&str>,
    amount: f64,
    metadata: HashMap<String, Value>,
) -> Transaction {
    Transaction {
        id: Uuid::new_v4().to_string(),
        tx_type,
        from: from.map(str::to_string),
        to: to.map(str::to_string),
        amount,
        metadata,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64,
        signature: None,
    }
}
