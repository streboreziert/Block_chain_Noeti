use noetis_protocol::{Transaction, TransactionType};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use thiserror::Error;
use uuid::Uuid;

pub const FAUCET_AMOUNT: f64 = 1000.0;
pub const FAUCET_COOLDOWN_MS: i64 = 60_000;
pub const NETWORK_FEE_RATE: f64 = 0.02;
pub const VALIDATOR_REWARD_RATE: f64 = 0.01;
pub const NODE_STAKE_AMOUNT: f64 = 10.0;

static FAUCET_LAST_CLAIM: LazyLock<Mutex<HashMap<String, i64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, PartialEq)]
pub enum EscrowStatus {
    Locked,
    Released,
    Settled,
}

#[derive(Debug, Clone)]
pub struct EscrowRecord {
    pub task_id: String,
    pub user_address: String,
    pub locked_amount: f64,
    pub spent_amount: f64,
    pub status: EscrowStatus,
}

#[derive(Debug, Clone, Default)]
pub struct LedgerState {
    pub balances: HashMap<String, f64>,
    pub escrows: HashMap<String, EscrowRecord>,
    pub transactions: Vec<Transaction>,
    pub used_nonces: HashSet<String>,
}

#[derive(Debug, Error)]
pub enum CurrencyError {
    #[error("Faucet cooldown active. Development-only faucet allows one claim per minute.")]
    FaucetCooldown,
    #[error("Amount must be positive")]
    InvalidAmount,
    #[error("Insufficient balance")]
    InsufficientBalance,
    #[error("Insufficient balance for escrow")]
    InsufficientEscrowBalance,
    #[error("Escrow not found")]
    EscrowNotFound,
}

pub type CurrencyResult<T> = Result<T, CurrencyError>;

pub fn create_ledger() -> LedgerState {
    LedgerState::default()
}

pub fn get_balance(ledger: &LedgerState, address: &str) -> f64 {
    *ledger.balances.get(address).unwrap_or(&0.0)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn record_tx(
    ledger: &mut LedgerState,
    tx_type: TransactionType,
    from: Option<&str>,
    to: Option<&str>,
    amount: f64,
    metadata: HashMap<String, Value>,
) -> Transaction {
    let tx = Transaction {
        id: Uuid::new_v4().to_string(),
        tx_type,
        from: from.map(str::to_string),
        to: to.map(str::to_string),
        amount,
        metadata,
        timestamp: now_ms(),
        signature: None,
    };
    ledger.transactions.push(tx.clone());
    tx
}

pub fn create_wallet_account(ledger: &mut LedgerState, address: &str) -> Transaction {
    ledger.balances.entry(address.to_string()).or_insert(0.0);
    let mut metadata = HashMap::new();
    metadata.insert("address".into(), json!(address));
    record_tx(
        ledger,
        TransactionType::WalletCreated,
        None,
        Some(address),
        0.0,
        metadata,
    )
}

pub fn faucet_transfer(
    ledger: &mut LedgerState,
    address: &str,
) -> CurrencyResult<(Transaction, f64)> {
    let now = now_ms();
    {
        let mut claims = FAUCET_LAST_CLAIM.lock().unwrap();
        let last = *claims.get(address).unwrap_or(&0);
        if now - last < FAUCET_COOLDOWN_MS {
            return Err(CurrencyError::FaucetCooldown);
        }
        claims.insert(address.to_string(), now);
    }

    let balance = get_balance(ledger, address);
    ledger.balances.insert(address.to_string(), balance + FAUCET_AMOUNT);

    let mut metadata = HashMap::new();
    metadata.insert(
        "note".into(),
        json!("DEVELOPMENT ONLY — test NOET has no real value"),
    );
    let tx = record_tx(
        ledger,
        TransactionType::FaucetTransfer,
        Some("faucet-dev-only"),
        Some(address),
        FAUCET_AMOUNT,
        metadata,
    );
    Ok((tx, FAUCET_AMOUNT))
}

pub fn transfer(
    ledger: &mut LedgerState,
    from: &str,
    to: &str,
    amount: f64,
    metadata: HashMap<String, Value>,
) -> CurrencyResult<Transaction> {
    if amount <= 0.0 {
        return Err(CurrencyError::InvalidAmount);
    }
    let from_balance = get_balance(ledger, from);
    if from_balance < amount {
        return Err(CurrencyError::InsufficientBalance);
    }
    ledger.balances.insert(from.to_string(), from_balance - amount);
    ledger
        .balances
        .insert(to.to_string(), get_balance(ledger, to) + amount);
    Ok(record_tx(
        ledger,
        TransactionType::CurrencyTransfer,
        Some(from),
        Some(to),
        amount,
        metadata,
    ))
}

pub fn lock_escrow(
    ledger: &mut LedgerState,
    task_id: &str,
    user_address: &str,
    amount: f64,
) -> CurrencyResult<EscrowRecord> {
    let balance = get_balance(ledger, user_address);
    if balance < amount {
        return Err(CurrencyError::InsufficientEscrowBalance);
    }
    ledger
        .balances
        .insert(user_address.to_string(), balance - amount);

    let escrow = EscrowRecord {
        task_id: task_id.to_string(),
        user_address: user_address.to_string(),
        locked_amount: amount,
        spent_amount: 0.0,
        status: EscrowStatus::Locked,
    };
    ledger.escrows.insert(task_id.to_string(), escrow.clone());

    let mut metadata = HashMap::new();
    metadata.insert("taskId".into(), json!(task_id));
    record_tx(
        ledger,
        TransactionType::TaskFunded,
        Some(user_address),
        Some(&format!("escrow:{task_id}")),
        amount,
        metadata,
    );
    Ok(escrow)
}

pub struct EscrowPayment {
    pub to: String,
    pub amount: f64,
    pub payment_type: TransactionType,
}

pub fn settle_escrow(
    ledger: &mut LedgerState,
    task_id: &str,
    payments: &[EscrowPayment],
) -> CurrencyResult<(f64, Vec<Transaction>)> {
    let escrow = ledger
        .escrows
        .get_mut(task_id)
        .ok_or(CurrencyError::EscrowNotFound)?;

    let mut txs = Vec::new();
    let mut spent = 0.0;
    let user_address = escrow.user_address.clone();
    let locked_amount = escrow.locked_amount;
    let escrow_from = format!("escrow:{task_id}");

    for payment in payments {
        if payment.amount <= 0.0 {
            continue;
        }
        spent += payment.amount;
        ledger.balances.insert(
            payment.to.clone(),
            get_balance(ledger, &payment.to) + payment.amount,
        );
        let mut metadata = HashMap::new();
        metadata.insert("taskId".into(), json!(task_id));
        txs.push(record_tx(
            ledger,
            payment.payment_type.clone(),
            Some(&escrow_from),
            Some(&payment.to),
            payment.amount,
            metadata,
        ));
    }

    let refund = locked_amount - spent;
    if refund > 0.0 {
        ledger.balances.insert(
            user_address.clone(),
            get_balance(ledger, &user_address) + refund,
        );
        let mut metadata = HashMap::new();
        metadata.insert("taskId".into(), json!(task_id));
        txs.push(record_tx(
            ledger,
            TransactionType::TaskRefunded,
            Some(&escrow_from),
            Some(&user_address),
            refund,
            metadata,
        ));
    }

    if let Some(escrow) = ledger.escrows.get_mut(task_id) {
        escrow.spent_amount = spent;
        escrow.status = EscrowStatus::Settled;
    }

    Ok((refund, txs))
}

pub fn stake_node(ledger: &mut LedgerState, node_address: &str) -> CurrencyResult<Transaction> {
    transfer(
        ledger,
        node_address,
        "staking-pool",
        NODE_STAKE_AMOUNT,
        HashMap::from([("reason".into(), json!("node_stake"))]),
    )?;
    Ok(record_tx(
        ledger,
        TransactionType::NodeStaked,
        Some(node_address),
        Some("staking-pool"),
        NODE_STAKE_AMOUNT,
        HashMap::new(),
    ))
}

pub fn penalize_node(
    ledger: &mut LedgerState,
    node_address: &str,
    amount: f64,
    reason: &str,
) -> Transaction {
    let stake = amount.min(get_balance(ledger, node_address));
    if stake > 0.0 {
        ledger.balances.insert(
            node_address.to_string(),
            get_balance(ledger, node_address) - stake,
        );
    }
    record_tx(
        ledger,
        TransactionType::NodePenalized,
        Some(node_address),
        Some("penalty-pool"),
        stake,
        HashMap::from([("reason".into(), json!(reason))]),
    )
}

#[derive(Debug, Clone)]
pub struct PriceEstimateInput {
    pub input_tokens: i64,
    pub max_output_tokens: i64,
    pub model: String,
    pub node_count: i64,
    pub verification_level: String,
    pub node_input_price: f64,
    pub node_output_price: f64,
}

fn model_multiplier(model: &str) -> f64 {
    const MODELS: &[(&str, f64)] = &[
        ("llama3.2:1b", 1.0),
        ("llama3.2:3b", 1.5),
        ("llama3.2", 1.5),
        ("llama3.1:8b", 2.0),
        ("mistral:7b", 2.0),
    ];
    for (key, mult) in MODELS {
        if model.contains(key) {
            return *mult;
        }
    }
    1.2
}

pub fn estimate_task_price(input: &PriceEstimateInput) -> f64 {
    let model_multiplier = model_multiplier(&input.model);
    let verification_multiplier = match input.verification_level.as_str() {
        "high" => 3.0,
        "medium" => 2.0,
        _ => 1.0,
    };
    let base = input.input_tokens as f64 * input.node_input_price
        + input.max_output_tokens as f64 * input.node_output_price;
    let node_cost = base * model_multiplier * input.node_count as f64 * verification_multiplier;
    let network_fee = node_cost * NETWORK_FEE_RATE;
    let validator_fee = node_cost * VALIDATOR_REWARD_RATE;
    ((node_cost + network_fee + validator_fee) * 1_000_000.0).ceil() / 1_000_000.0
}

pub fn total_supply(ledger: &LedgerState) -> f64 {
    ledger.balances.values().sum()
}
