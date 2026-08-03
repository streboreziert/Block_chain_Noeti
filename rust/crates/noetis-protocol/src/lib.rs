use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WsMessageType {
    NodeRegister,
    NodeHeartbeat,
    TaskOffer,
    TaskAccept,
    TaskReject,
    TaskPayload,
    TaskProgress,
    TaskResult,
    TaskCancel,
    RewardConfirmed,
    Registered,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsMessage {
    #[serde(rename = "type")]
    pub msg_type: WsMessageType,
    pub message_id: String,
    pub timestamp: i64,
    pub sender: String,
    pub payload: Value,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeModel {
    pub name: String,
    pub model_hash: String,
    pub context_length: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRegistration {
    pub node_id: String,
    pub wallet_address: String,
    pub models: Vec<NodeModel>,
    pub cpu: String,
    #[serde(default)]
    pub gpu: Option<String>,
    pub ram_gb: f64,
    #[serde(default)]
    pub vram_gb: Option<f64>,
    pub operating_system: String,
    pub price_per_input_token: f64,
    pub price_per_output_token: f64,
    pub maximum_parallel_tasks: i32,
    #[serde(default)]
    pub reputation: f64,
    #[serde(default = "default_available")]
    pub status: String,
    pub public_key: String,
    #[serde(default)]
    pub box_public_key: Option<String>,
    #[serde(default = "default_true")]
    pub accepts_redundant: bool,
    #[serde(default)]
    pub minimum_task_payment: f64,
}

fn default_available() -> String {
    "available".into()
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessingMode {
    Single,
    Redundant,
    Subtask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Created,
    PriceEstimated,
    EscrowLocked,
    NodesFound,
    NodeSelected,
    PromptDelivered,
    InferenceStarted,
    ResultReturned,
    ResultVerified,
    NodePaid,
    Refunded,
    Finalized,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTaskRequest {
    pub wallet_address: String,
    pub prompt: String,
    pub model: String,
    pub max_output_tokens: i32,
    #[serde(default = "default_verification")]
    pub verification_level: VerificationLevel,
    #[serde(default = "default_mode")]
    pub processing_mode: ProcessingMode,
    pub signature: String,
    pub timestamp: i64,
    pub nonce: String,
}

fn default_verification() -> VerificationLevel {
    VerificationLevel::Low
}
fn default_mode() -> ProcessingMode {
    ProcessingMode::Single
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TransactionType {
    WalletCreated,
    FaucetTransfer,
    CurrencyTransfer,
    NodeRegistered,
    NodeStaked,
    TaskCreated,
    TaskFunded,
    TaskAssigned,
    ResultSubmitted,
    ResultVerified,
    TaskPaid,
    TaskRefunded,
    NodePenalized,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub id: String,
    #[serde(rename = "type")]
    pub tx_type: TransactionType,
    pub from: Option<String>,
    pub to: Option<String>,
    pub amount: f64,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
    pub timestamp: i64,
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub block_number: i64,
    pub previous_hash: String,
    pub timestamp: i64,
    pub transactions: Vec<Transaction>,
    #[serde(default)]
    pub task_settlements: Vec<HashMap<String, Value>>,
    pub validator_signature: String,
    pub hash: String,
    #[serde(default)]
    pub proposer_id: Option<String>,
    #[serde(default)]
    pub validator_signatures: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum P2pMessageType {
    Hello,
    BlockProposed,
    BlockAttest,
    BlockFinal,
    TxGossip,
    ChainRequest,
    ChainResponse,
    TaskOffer,
    TaskAccept,
    TaskResult,
    NodeAnnounce,
    PeerList,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct P2pMessage {
    #[serde(rename = "type")]
    pub msg_type: P2pMessageType,
    pub message_id: String,
    pub timestamp: i64,
    pub sender_id: String,
    pub payload: HashMap<String, Value>,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkStats {
    pub total_nodes: i64,
    pub online_nodes: i64,
    pub total_tasks: i64,
    pub completed_tasks: i64,
    pub total_noet_supply: f64,
    pub block_height: i64,
}
