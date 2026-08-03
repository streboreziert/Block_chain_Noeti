use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use noetis_protocol::TaskStatus;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::env;
use uuid::Uuid;

pub async fn create_pool(connection_string: Option<&str>) -> Result<PgPool> {
    let url = connection_string
        .map(str::to_string)
        .or_else(|| env::var("DATABASE_URL").ok())
        .unwrap_or_else(|| "postgresql://noetis:noetis@localhost:5432/noetis".into());
    PgPoolOptions::new()
        .max_connections(10)
        .connect(&url)
        .await
        .context("failed to connect to postgres")
}

pub async fn migrate(pool: &PgPool) -> Result<()> {
    let schema = include_str!("schema.sql");
    for statement in schema.split(';') {
        let trimmed = statement.trim();
        if trimmed.is_empty() {
            continue;
        }
        sqlx::query(trimmed).execute(pool).await?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct TaskRecord {
    pub id: Uuid,
    pub user_address: String,
    pub model: String,
    pub prompt_hash: String,
    pub result_hash: Option<String>,
    pub result_text: Option<String>,
    pub max_output_tokens: i32,
    pub verification_level: String,
    pub processing_mode: String,
    pub estimated_price: f64,
    pub actual_price: Option<f64>,
    pub status: String,
    pub node_addresses: Vec<String>,
    pub verification_result: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct CreateTaskInput {
    pub id: Uuid,
    pub user_address: String,
    pub model: String,
    pub prompt_hash: String,
    pub max_output_tokens: i32,
    pub verification_level: String,
    pub processing_mode: String,
    pub estimated_price: f64,
    pub status: String,
    pub node_addresses: Vec<String>,
}

pub struct TaskRepository {
    pool: PgPool,
}

impl TaskRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn create_task(&self, data: CreateTaskInput) -> Result<TaskRecord> {
        let row = sqlx::query(
            "INSERT INTO tasks (id, user_address, model, prompt_hash, max_output_tokens, verification_level, processing_mode, estimated_price, status, node_addresses)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        )
        .bind(data.id)
        .bind(&data.user_address)
        .bind(&data.model)
        .bind(&data.prompt_hash)
        .bind(data.max_output_tokens)
        .bind(&data.verification_level)
        .bind(&data.processing_mode)
        .bind(data.estimated_price)
        .bind(&data.status)
        .bind(&data.node_addresses)
        .fetch_one(&self.pool)
        .await?;
        Ok(row_to_task(row))
    }

    pub async fn update_status(
        &self,
        id: Uuid,
        status: TaskStatus,
        extra: TaskUpdateExtra<'_>,
    ) -> Result<()> {
        let status_str = task_status_str(&status);
        let mut fields = vec!["status = $2".to_string(), "updated_at = NOW()".to_string()];
        let mut idx = 3i32;

        if extra.result_hash.is_some() {
            fields.push(format!("result_hash = ${idx}"));
            idx += 1;
        }
        if extra.result_text.is_some() {
            fields.push(format!("result_text = ${idx}"));
            idx += 1;
        }
        if extra.actual_price.is_some() {
            fields.push(format!("actual_price = ${idx}"));
            idx += 1;
        }
        if extra.verification_result.is_some() {
            fields.push(format!("verification_result = ${idx}"));
            idx += 1;
        }
        if extra.node_addresses.is_some() {
            fields.push(format!("node_addresses = ${idx}"));
        }

        let query = format!("UPDATE tasks SET {} WHERE id = $1", fields.join(", "));
        let mut q = sqlx::query(&query).bind(id).bind(status_str);
        if let Some(v) = extra.result_hash {
            q = q.bind(v);
        }
        if let Some(v) = extra.result_text {
            q = q.bind(v);
        }
        if let Some(v) = extra.actual_price {
            q = q.bind(v);
        }
        if let Some(v) = extra.verification_result {
            q = q.bind(v);
        }
        if let Some(v) = extra.node_addresses {
            q = q.bind(v);
        }
        q.execute(&self.pool).await?;
        Ok(())
    }

    pub async fn get_task(&self, id: Uuid) -> Result<Option<TaskRecord>> {
        let row = sqlx::query("SELECT * FROM tasks WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(row_to_task))
    }

    pub async fn list_tasks(
        &self,
        user_address: Option<&str>,
        limit: i64,
    ) -> Result<Vec<TaskRecord>> {
        let rows = if let Some(addr) = user_address {
            sqlx::query(
                "SELECT * FROM tasks WHERE user_address = $1 ORDER BY created_at DESC LIMIT $2",
            )
            .bind(addr)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1")
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
        };
        Ok(rows.into_iter().map(row_to_task).collect())
    }

    pub async fn count_tasks(&self) -> Result<i32> {
        let row = sqlx::query("SELECT COUNT(*)::int AS c FROM tasks")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get("c"))
    }

    pub async fn count_completed(&self) -> Result<i32> {
        let row = sqlx::query("SELECT COUNT(*)::int AS c FROM tasks WHERE status = 'finalized'")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get("c"))
    }
}

pub struct TaskUpdateExtra<'a> {
    pub result_hash: Option<&'a str>,
    pub result_text: Option<&'a str>,
    pub actual_price: Option<f64>,
    pub verification_result: Option<Value>,
    pub node_addresses: Option<&'a [String]>,
}

impl<'a> Default for TaskUpdateExtra<'a> {
    fn default() -> Self {
        Self {
            result_hash: None,
            result_text: None,
            actual_price: None,
            verification_result: None,
            node_addresses: None,
        }
    }
}

fn row_to_task(row: sqlx::postgres::PgRow) -> TaskRecord {
    TaskRecord {
        id: row.get("id"),
        user_address: row.get("user_address"),
        model: row.get("model"),
        prompt_hash: row.get("prompt_hash"),
        result_hash: row.get("result_hash"),
        result_text: row.get("result_text"),
        max_output_tokens: row.get("max_output_tokens"),
        verification_level: row.get("verification_level"),
        processing_mode: row.get("processing_mode"),
        estimated_price: row.get("estimated_price"),
        actual_price: row.get("actual_price"),
        status: row.get("status"),
        node_addresses: row.get("node_addresses"),
        verification_result: row.get("verification_result"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn task_status_str(status: &TaskStatus) -> &'static str {
    match status {
        TaskStatus::Created => "created",
        TaskStatus::PriceEstimated => "price_estimated",
        TaskStatus::EscrowLocked => "escrow_locked",
        TaskStatus::NodesFound => "nodes_found",
        TaskStatus::NodeSelected => "node_selected",
        TaskStatus::PromptDelivered => "prompt_delivered",
        TaskStatus::InferenceStarted => "inference_started",
        TaskStatus::ResultReturned => "result_returned",
        TaskStatus::ResultVerified => "result_verified",
        TaskStatus::NodePaid => "node_paid",
        TaskStatus::Refunded => "refunded",
        TaskStatus::Finalized => "finalized",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    }
}

#[derive(Debug, Clone)]
pub struct WalletRecord {
    pub address: String,
    pub public_key: String,
    pub balance: f64,
}

pub struct WalletRepository {
    pool: PgPool,
}

impl WalletRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn upsert_wallet(&self, address: &str, public_key: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO wallets (address, public_key, balance) VALUES ($1, $2, 0)
             ON CONFLICT (address) DO UPDATE SET public_key = EXCLUDED.public_key",
        )
        .bind(address)
        .bind(public_key)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_wallet(&self, address: &str) -> Result<Option<WalletRecord>> {
        let row = sqlx::query("SELECT * FROM wallets WHERE address = $1")
            .bind(address)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| WalletRecord {
            address: r.get("address"),
            public_key: r.get("public_key"),
            balance: r.get("balance"),
        }))
    }

    pub async fn set_balance(&self, address: &str, balance: f64) -> Result<()> {
        sqlx::query("UPDATE wallets SET balance = $2, updated_at = NOW() WHERE address = $1")
            .bind(address)
            .bind(balance)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn increment_balance(&self, address: &str, delta: f64) -> Result<f64> {
        let row = sqlx::query(
            "UPDATE wallets SET balance = balance + $2, updated_at = NOW() WHERE address = $1 RETURNING balance",
        )
        .bind(address)
        .bind(delta)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.get::<f64, _>("balance")).unwrap_or(0.0))
    }

    pub async fn total_supply(&self) -> Result<f64> {
        let row = sqlx::query("SELECT COALESCE(SUM(balance), 0)::float8 AS total FROM wallets")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get("total"))
    }
}

pub struct NodeUpsertInput {
    pub node_id: String,
    pub wallet_address: String,
    pub public_key: String,
    pub models: Value,
    pub cpu: Option<String>,
    pub gpu: Option<String>,
    pub ram_gb: Option<f64>,
    pub vram_gb: Option<f64>,
    pub operating_system: Option<String>,
    pub price_per_input_token: f64,
    pub price_per_output_token: f64,
    pub maximum_parallel_tasks: i32,
    pub reputation: f64,
    pub status: String,
    pub metadata: Value,
}

pub struct NodeRepository {
    pool: PgPool,
}

impl NodeRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn upsert_node(&self, node: NodeUpsertInput) -> Result<()> {
        sqlx::query(
            "INSERT INTO nodes (node_id, wallet_address, public_key, models, cpu, gpu, ram_gb, vram_gb, operating_system,
              price_per_input_token, price_per_output_token, maximum_parallel_tasks, reputation, status, metadata, last_heartbeat)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
             ON CONFLICT (node_id) DO UPDATE SET
               models = EXCLUDED.models, status = EXCLUDED.status, reputation = EXCLUDED.reputation,
               last_heartbeat = NOW(), metadata = EXCLUDED.metadata",
        )
        .bind(&node.node_id)
        .bind(&node.wallet_address)
        .bind(&node.public_key)
        .bind(&node.models)
        .bind(&node.cpu)
        .bind(&node.gpu)
        .bind(node.ram_gb)
        .bind(node.vram_gb)
        .bind(&node.operating_system)
        .bind(node.price_per_input_token)
        .bind(node.price_per_output_token)
        .bind(node.maximum_parallel_tasks)
        .bind(node.reputation)
        .bind(&node.status)
        .bind(&node.metadata)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_nodes(&self) -> Result<Vec<Value>> {
        let rows = sqlx::query("SELECT * FROM nodes ORDER BY last_heartbeat DESC")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                serde_json::json!({
                    "node_id": r.get::<String, _>("node_id"),
                    "wallet_address": r.get::<String, _>("wallet_address"),
                    "public_key": r.get::<String, _>("public_key"),
                    "models": r.get::<Value, _>("models"),
                    "cpu": r.get::<Option<String>, _>("cpu"),
                    "gpu": r.get::<Option<String>, _>("gpu"),
                    "ram_gb": r.get::<Option<f64>, _>("ram_gb"),
                    "vram_gb": r.get::<Option<f64>, _>("vram_gb"),
                    "operating_system": r.get::<Option<String>, _>("operating_system"),
                    "price_per_input_token": r.get::<f64, _>("price_per_input_token"),
                    "price_per_output_token": r.get::<f64, _>("price_per_output_token"),
                    "maximum_parallel_tasks": r.get::<i32, _>("maximum_parallel_tasks"),
                    "reputation": r.get::<f64, _>("reputation"),
                    "status": r.get::<String, _>("status"),
                    "metadata": r.get::<Value, _>("metadata"),
                    "last_heartbeat": r.get::<DateTime<Utc>, _>("last_heartbeat"),
                    "created_at": r.get::<DateTime<Utc>, _>("created_at"),
                })
            })
            .collect())
    }

    pub async fn count_online(&self, timeout_ms: i64) -> Result<i32> {
        let row = sqlx::query(
            "SELECT COUNT(*)::int AS c FROM nodes WHERE last_heartbeat > NOW() - ($1 || ' milliseconds')::interval",
        )
        .bind(timeout_ms.to_string())
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("c"))
    }

    pub async fn update_reputation(&self, node_id: &str, reputation: f64) -> Result<()> {
        sqlx::query("UPDATE nodes SET reputation = $2 WHERE node_id = $1")
            .bind(node_id)
            .bind(reputation)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

pub struct BlockRepository {
    pool: PgPool,
}

impl BlockRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn save_block(&self, block: &Value) -> Result<()> {
        sqlx::query(
            "INSERT INTO blocks (block_number, previous_hash, timestamp, transactions, task_settlements, validator_signature, hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (block_number) DO NOTHING",
        )
        .bind(block.get("block_number").and_then(|v| v.as_i64()).unwrap_or(0) as i32)
        .bind(block.get("previous_hash").and_then(|v| v.as_str()).unwrap_or(""))
        .bind(block.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0))
        .bind(block.get("transactions").cloned().unwrap_or(Value::Array(vec![])))
        .bind(
            block
                .get("task_settlements")
                .cloned()
                .unwrap_or(Value::Array(vec![])),
        )
        .bind(
            block
                .get("validator_signature")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        )
        .bind(block.get("hash").and_then(|v| v.as_str()).unwrap_or(""))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_height(&self) -> Result<i32> {
        let row = sqlx::query("SELECT COALESCE(MAX(block_number), 0)::int AS h FROM blocks")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get("h"))
    }

    pub async fn list_blocks(&self, limit: i64) -> Result<Vec<Value>> {
        let rows = sqlx::query("SELECT * FROM blocks ORDER BY block_number DESC LIMIT $1")
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                serde_json::json!({
                    "block_number": r.get::<i32, _>("block_number"),
                    "previous_hash": r.get::<String, _>("previous_hash"),
                    "timestamp": r.get::<i64, _>("timestamp"),
                    "transactions": r.get::<Value, _>("transactions"),
                    "task_settlements": r.get::<Value, _>("task_settlements"),
                    "validator_signature": r.get::<String, _>("validator_signature"),
                    "hash": r.get::<String, _>("hash"),
                    "created_at": r.get::<DateTime<Utc>, _>("created_at"),
                })
            })
            .collect())
    }
}

#[derive(Debug, Clone)]
pub struct ProgressEvent {
    pub status: String,
    pub message: Option<String>,
    pub created_at: DateTime<Utc>,
}

pub struct ProgressRepository {
    pool: PgPool,
}

impl ProgressRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn add_event(
        &self,
        task_id: Uuid,
        status: TaskStatus,
        message: Option<&str>,
    ) -> Result<()> {
        sqlx::query("INSERT INTO task_progress (task_id, status, message) VALUES ($1, $2, $3)")
            .bind(task_id)
            .bind(task_status_str(&status))
            .bind(message)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_events(&self, task_id: Uuid) -> Result<Vec<ProgressEvent>> {
        let rows = sqlx::query(
            "SELECT status, message, created_at FROM task_progress WHERE task_id = $1 ORDER BY created_at ASC",
        )
        .bind(task_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| ProgressEvent {
                status: r.get("status"),
                message: r.get("message"),
                created_at: r.get("created_at"),
            })
            .collect())
    }
}
