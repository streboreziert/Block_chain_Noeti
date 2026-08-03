mod mempool;
mod state;
mod storage;

pub use mempool::{create_tx, Mempool};
pub use state::{
    apply_block_transactions, apply_transaction, create_account_state, derive_state_from_chain,
    get_balance as get_account_balance, ChainAccountState, EscrowEntry,
};
pub use storage::{pick_longest_chain, ChainStore, ChainStoreData};

use noetis_crypto::{hash_str, sign_message, verify_signature, Wallet};
use noetis_protocol::{Block, Transaction};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Validator {
    pub id: String,
    pub public_key: String,
    pub wallet: Wallet,
    pub stake: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct BlockchainState {
    pub chain: Vec<Block>,
    pub validators: Vec<Validator>,
    pub pending_transactions: Vec<Transaction>,
    pub pending_settlements: Vec<HashMap<String, Value>>,
}

pub type AttestedBlock = Block;

const GENESIS_PREVIOUS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Serialize)]
struct BlockHashInput<'a> {
    block_number: i64,
    previous_hash: &'a str,
    timestamp: i64,
    transactions: &'a [Transaction],
    task_settlements: &'a [HashMap<String, Value>],
    proposer_id: &'a str,
}

pub fn compute_block_hash(block: &Block) -> String {
    let payload = BlockHashInput {
        block_number: block.block_number,
        previous_hash: &block.previous_hash,
        timestamp: block.timestamp,
        transactions: &block.transactions,
        task_settlements: &block.task_settlements,
        proposer_id: block.proposer_id.as_deref().unwrap_or(""),
    };
    hash_str(&serde_json::to_string(&payload).unwrap_or_default())
}

pub fn create_genesis_block(validators: &[Validator]) -> AttestedBlock {
    let proposer_id = validators
        .first()
        .map(|v| v.id.clone())
        .unwrap_or_else(|| "genesis".into());

    let mut block = Block {
        block_number: 0,
        previous_hash: GENESIS_PREVIOUS.into(),
        timestamp: now_ms(),
        transactions: vec![],
        task_settlements: vec![],
        validator_signature: String::new(),
        hash: String::new(),
        proposer_id: Some(proposer_id),
        validator_signatures: Some(HashMap::new()),
    };
    block.hash = compute_block_hash(&block);
    block
}

pub fn create_blockchain(validators: Vec<Validator>) -> BlockchainState {
    let mut genesis = create_genesis_block(&validators);
    if let Some(validator) = validators.first() {
        let signature = sign_block_body(&genesis, validator);
        genesis.validator_signature = signature.clone();
        genesis.validator_signatures = Some(HashMap::from([(validator.id.clone(), signature)]));
    }

    BlockchainState {
        chain: vec![genesis],
        validators,
        pending_transactions: vec![],
        pending_settlements: vec![],
    }
}

pub fn sign_block_body(block: &Block, validator: &Validator) -> String {
    sign_message(&compute_block_hash(block), &validator.wallet)
}

pub fn get_latest_block(state: &BlockchainState) -> &Block {
    state.chain.last().expect("chain must not be empty")
}

pub fn get_block_height(state: &BlockchainState) -> i64 {
    (state.chain.len() as i64) - 1
}

pub fn queue_transaction(state: &mut BlockchainState, tx: Transaction) {
    state.pending_transactions.push(tx);
}

pub fn queue_settlement(state: &mut BlockchainState, settlement: HashMap<String, Value>) {
    state.pending_settlements.push(settlement);
}

pub fn quorum_size(validator_count: usize) -> usize {
    (validator_count * 2 / 3) + 1
}

pub fn get_proposer(validators: &[Validator], block_number: i64) -> &Validator {
    let idx = (block_number as usize) % validators.len();
    &validators[idx]
}

pub fn propose_block(state: &BlockchainState, proposer: &Validator) -> AttestedBlock {
    let latest = get_latest_block(state);
    let mut block = Block {
        block_number: latest.block_number + 1,
        previous_hash: latest.hash.clone(),
        timestamp: now_ms(),
        transactions: state.pending_transactions.clone(),
        task_settlements: state.pending_settlements.clone(),
        validator_signature: String::new(),
        hash: String::new(),
        proposer_id: Some(proposer.id.clone()),
        validator_signatures: Some(HashMap::new()),
    };

    let signature = sign_block_body(&block, proposer);
    block.validator_signature = signature.clone();
    block.validator_signatures = Some(HashMap::from([(proposer.id.clone(), signature)]));
    block.hash = compute_block_hash(&block);
    block
}

pub fn attest_block(block: &AttestedBlock, validator: &Validator) -> AttestedBlock {
    let sig = sign_block_body(block, validator);
    let mut validator_signatures = block.validator_signatures.clone().unwrap_or_default();
    validator_signatures.insert(validator.id.clone(), sig);
    Block {
        validator_signatures: Some(validator_signatures),
        ..block.clone()
    }
}

pub fn validate_block_signatures(
    block: &AttestedBlock,
    previous: &Block,
    validators: &[Validator],
) -> bool {
    if block.hash != compute_block_hash(block) {
        return false;
    }
    if block.previous_hash != previous.hash {
        return false;
    }
    if block.block_number != previous.block_number + 1 {
        return false;
    }

    let sigs = block.validator_signatures.as_ref().cloned().unwrap_or_default();
    let mut valid_count = 0usize;
    for validator in validators {
        let Some(sig) = sigs.get(&validator.id) else {
            continue;
        };
        if verify_signature(&block.hash, sig, &validator.public_key) {
            valid_count += 1;
        }
    }
    valid_count >= quorum_size(validators.len())
}

pub fn validate_chain(state: &BlockchainState) -> bool {
    if state.chain.is_empty() {
        return false;
    }
    for i in 1..state.chain.len() {
        if !validate_block_signatures(&state.chain[i], &state.chain[i - 1], &state.validators) {
            return false;
        }
    }
    true
}

pub fn apply_block(state: &mut BlockchainState, block: AttestedBlock) {
    state.chain.push(block);
    state.pending_transactions.clear();
    state.pending_settlements.clear();
}

pub fn replace_chain(state: &mut BlockchainState, new_chain: Vec<Block>) {
    state.chain = new_chain;
}

pub trait ConsensusEngine {
    fn propose_block(&self, state: &BlockchainState) -> AttestedBlock;
    fn validate_chain(&self, state: &BlockchainState) -> bool;
    fn quorum(&self) -> usize;
}

pub struct MultiValidatorConsensus {
    validators: Vec<Validator>,
}

impl MultiValidatorConsensus {
    pub fn new(validators: Vec<Validator>) -> Self {
        Self { validators }
    }
}

impl ConsensusEngine for MultiValidatorConsensus {
    fn propose_block(&self, state: &BlockchainState) -> AttestedBlock {
        let proposer = get_proposer(&self.validators, get_block_height(state) + 1);
        propose_block(state, proposer)
    }

    fn validate_chain(&self, state: &BlockchainState) -> bool {
        validate_chain(state)
    }

    fn quorum(&self) -> usize {
        quorum_size(self.validators.len())
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct StakeEntry {
    pub validator_id: String,
    pub address: String,
    pub stake: f64,
    pub slashed: f64,
}

pub struct StakeRegistry {
    stakes: HashMap<String, StakeEntry>,
}

impl Default for StakeRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl StakeRegistry {
    pub fn new() -> Self {
        Self {
            stakes: HashMap::new(),
        }
    }

    pub fn register(&mut self, entry: StakeEntry) {
        self.stakes.insert(entry.validator_id.clone(), entry);
    }

    pub fn get_stake(&self, validator_id: &str) -> f64 {
        self.stakes
            .get(validator_id)
            .map(|e| e.stake)
            .unwrap_or(0.0)
    }

    pub fn slash(&mut self, validator_id: &str, amount: f64) {
        let Some(entry) = self.stakes.get_mut(validator_id) else {
            return;
        };
        entry.slashed += amount;
        entry.stake = (entry.stake - amount).max(0.0);
    }

    pub fn top_validators(&self, limit: usize) -> Vec<StakeEntry> {
        let mut entries: Vec<StakeEntry> = self
            .stakes
            .values()
            .filter(|s| s.stake > 0.0)
            .cloned()
            .collect();
        entries.sort_by(|a, b| b.stake.partial_cmp(&a.stake).unwrap_or(std::cmp::Ordering::Equal));
        entries.truncate(limit);
        entries
    }

    pub fn to_json(&self) -> Vec<StakeEntry> {
        self.stakes.values().cloned().collect()
    }

    pub fn from_json(data: &[StakeEntry]) -> Self {
        let mut registry = Self::new();
        for entry in data {
            registry.register(entry.clone());
        }
        registry
    }
}

pub struct ProofOfAuthorityConsensus {
    validator: Validator,
}

impl ProofOfAuthorityConsensus {
    pub fn new(validator: Validator) -> Self {
        Self { validator }
    }
}

impl ConsensusEngine for ProofOfAuthorityConsensus {
    fn propose_block(&self, state: &BlockchainState) -> AttestedBlock {
        propose_block(state, &self.validator)
    }

    fn validate_chain(&self, state: &BlockchainState) -> bool {
        let narrowed = BlockchainState {
            validators: vec![self.validator.clone()],
            ..state.clone()
        };
        validate_chain(&narrowed)
    }

    fn quorum(&self) -> usize {
        1
    }
}

pub fn produce_block(state: &mut BlockchainState, validator: &Validator) -> Block {
    let block = propose_block(state, validator);
    apply_block(state, block.clone());
    block
}

pub fn validate_block(block: &Block, previous: &Block, validators: &[Validator]) -> bool {
    validate_block_signatures(block, previous, validators)
}

pub fn create_genesis_block_legacy(validators: &[Validator]) -> AttestedBlock {
    create_genesis_block(validators)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use noetis_crypto::create_wallet;

    #[test]
    fn multi_validator_attested_blocks() {
        let w1 = create_wallet();
        let w2 = create_wallet();
        let v1 = Validator {
            id: "v1".into(),
            public_key: w1.public_key.clone(),
            wallet: w1,
            stake: None,
        };
        let v2 = Validator {
            id: "v2".into(),
            public_key: w2.public_key.clone(),
            wallet: w2,
            stake: None,
        };
        let mut state = create_blockchain(vec![v1.clone(), v2.clone()]);
        assert_eq!(quorum_size(2), 2);

        let proposed = propose_block(&state, &v1);
        let attested = attest_block(&proposed, &v2);
        apply_block(&mut state, attested);

        let consensus = MultiValidatorConsensus::new(vec![v1, v2]);
        assert!(consensus.validate_chain(&state));
        assert_eq!(state.chain.len(), 2);
    }
}
