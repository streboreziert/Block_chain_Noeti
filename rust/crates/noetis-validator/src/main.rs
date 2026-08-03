use anyhow::Result;
use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use noetis_blockchain::{
    create_blockchain, produce_block, queue_settlement, queue_transaction, BlockchainState,
    Validator,
};
use noetis_crypto::{create_wallet, hash_str, verify_payload_signature, Wallet};
use noetis_currency::{NETWORK_FEE_RATE, VALIDATOR_REWARD_RATE};
use noetis_db::{
    create_pool, migrate, BlockRepository, ProgressRepository, TaskRepository, WalletRepository,
};
use noetis_protocol::TaskStatus;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::trace::TraceLayer;
use tracing::info;
use uuid::Uuid;

struct AppState {
    pool: PgPool,
    tasks: TaskRepository,
    wallets: WalletRepository,
    nodes: noetis_db::NodeRepository,
    blocks: BlockRepository,
    progress: ProgressRepository,
    chain: Mutex<BlockchainState>,
    validator_wallet: Wallet,
    task_results: Mutex<HashMap<String, Vec<Value>>>,
}

#[derive(Deserialize, Serialize)]
struct VerifyBody {
    task_id: Option<String>,
    node_id: Option<String>,
    node_address: Option<String>,
    result: Option<String>,
    result_hash: Option<String>,
    signature: Option<String>,
    public_key: Option<String>,
    duration_ms: Option<i64>,
    #[allow(dead_code)]
    input_tokens: Option<i64>,
    #[allow(dead_code)]
    output_tokens: Option<i64>,
}

fn semantic_similarity(a: &str, b: &str) -> f64 {
    let words_a: std::collections::HashSet<String> = a
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let words_b: std::collections::HashSet<String> = b
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if words_a.is_empty() && words_b.is_empty() {
        return 1.0;
    }
    let intersection = words_a.intersection(&words_b).count();
    intersection as f64 / words_a.len().max(words_b.len()) as f64
}

fn update_reputation(current: f64, success: bool, duration_ms: i64) -> f64 {
    let delta = if success { 2.0 } else { -5.0 };
    let speed_bonus = if duration_ms < 5000 {
        0.5
    } else if duration_ms > 30000 {
        -0.5
    } else {
        0.0
    };
    (current + delta + speed_bonus).clamp(0.0, 100.0)
}

async fn finalize_task(
    state: &AppState,
    task_id: &str,
    result_text: &str,
    verification: Value,
) -> Result<()> {
    let id = Uuid::parse_str(task_id)?;
    let task = state
        .tasks
        .get_task(id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("task not found"))?;
    if task.status == "finalized" {
        return Ok(());
    }

    let result_hash = hash_str(result_text);
    state
        .tasks
        .update_status(
            id,
            TaskStatus::ResultVerified,
            noetis_db::TaskUpdateExtra {
                result_hash: Some(&result_hash),
                result_text: Some(result_text),
                verification_result: Some(verification.clone()),
                ..Default::default()
            },
        )
        .await?;
    state
        .progress
        .add_event(id, TaskStatus::ResultVerified, None)
        .await?;

    let escrow: Option<(String, f64)> = sqlx::query_as::<_, (String, f64)>(
        "SELECT user_address, locked_amount FROM escrows WHERE task_id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;

    let Some((user_address, locked_amount)) = escrow else {
        return Ok(());
    };

    let node_payment = locked_amount * (1.0 - NETWORK_FEE_RATE - VALIDATOR_REWARD_RATE);
    let validator_payment = locked_amount * VALIDATOR_REWARD_RATE;
    let network_fee = locked_amount * NETWORK_FEE_RATE;

    let node_address = verification
        .get("winning_node_address")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| task.node_addresses.first().cloned())
        .unwrap_or_default();

    if !node_address.is_empty() {
        state.wallets.increment_balance(&node_address, node_payment).await?;
        state
            .progress
            .add_event(
                id,
                TaskStatus::NodePaid,
                Some(&format!("{node_payment} NOET to {node_address}")),
            )
            .await?;
    }
    state
        .wallets
        .increment_balance(&state.validator_wallet.address, validator_payment)
        .await?;

    let refund = locked_amount - node_payment - validator_payment - network_fee;
    if refund > 0.000001 {
        state.wallets.increment_balance(&user_address, refund).await?;
        state
            .progress
            .add_event(
                id,
                TaskStatus::Refunded,
                Some(&format!("{refund} NOET returned")),
            )
            .await?;
    }

    sqlx::query("UPDATE escrows SET status = 'settled', spent_amount = $2 WHERE task_id = $1")
        .bind(id)
        .bind(node_payment + validator_payment + network_fee)
        .execute(&state.pool)
        .await?;

    let actual = node_payment + validator_payment + network_fee;
    state
        .tasks
        .update_status(
            id,
            TaskStatus::Finalized,
            noetis_db::TaskUpdateExtra {
                actual_price: Some(actual),
                ..Default::default()
            },
        )
        .await?;
    state
        .progress
        .add_event(id, TaskStatus::Finalized, None)
        .await?;

    {
        let mut chain = state.chain.lock().await;
        queue_transaction(
            &mut chain,
            noetis_protocol::Transaction {
                id: Uuid::new_v4().to_string(),
                tx_type: noetis_protocol::TransactionType::ResultVerified,
                from: None,
                to: Some(node_address.clone()),
                amount: node_payment,
                metadata: HashMap::from([
                    ("task_id".into(), json!(task_id)),
                    ("result_hash".into(), json!(result_hash)),
                ]),
                timestamp: now_ms(),
                signature: None,
            },
        );
        queue_settlement(
            &mut chain,
            HashMap::from([
                ("task_id".into(), json!(task_id)),
                ("user_address".into(), json!(user_address)),
                ("node_address".into(), json!(node_address)),
                ("prompt_hash".into(), json!(task.prompt_hash)),
                ("result_hash".into(), json!(result_hash)),
                ("amount_paid".into(), json!(node_payment)),
            ]),
        );
        let validator = chain.validators[0].clone();
        let block = produce_block(&mut chain, &validator);
        state.blocks.save_block(&json!(block)).await?;
    }

    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "noetis-validator" }))
}

async fn internal_verify(
    State(state): State<Arc<AppState>>,
    Json(data): Json<VerifyBody>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let task_id = data.task_id.clone().unwrap_or_default();
    let result = data.result.clone().unwrap_or_default();
    let result_hash = data.result_hash.clone().unwrap_or_default();
    let public_key = data.public_key.clone().unwrap_or_default();
    let duration_ms = data.duration_ms.unwrap_or(0);

    if hash_str(&result) != result_hash {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Result hash mismatch" })),
        ));
    }

    let mut payload = BTreeMap::new();
    payload.insert("task_id".into(), json!(task_id));
    payload.insert("result".into(), json!(result));
    payload.insert("result_hash".into(), json!(result_hash));
    payload.insert("duration_ms".into(), json!(duration_ms));

    if !verify_payload_signature(
        &payload,
        data.signature.as_deref().unwrap_or(""),
        &public_key,
    ) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid result signature" })),
        ));
    }

    if result.trim().is_empty() {
        if let Some(node_id) = &data.node_id {
            let node_list = state.nodes.list_nodes().await.map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": e.to_string() })),
                )
            })?;
            if let Some(node) = node_list.iter().find(|n| {
                n.get("node_id").and_then(|v| v.as_str()) == Some(node_id.as_str())
            }) {
                let rep = node.get("reputation").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let new_rep = update_reputation(rep, false, duration_ms);
                let _ = state.nodes.update_reputation(node_id, new_rep).await;
            }
        }
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Empty result rejected" })),
        ));
    }

    let data_val = serde_json::to_value(&data).unwrap_or(json!({}));
    let mut existing = state.task_results.lock().await;
    let entry = existing.entry(task_id.clone()).or_default();
    entry.push(data_val);
    let count = entry.len();

    let id = Uuid::parse_str(&task_id).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid task id" })),
        )
    })?;
    let task = state
        .tasks
        .get_task(id)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?
        .ok_or((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Task not found" })),
        ))?;

    let required = match task.verification_level.as_str() {
        "high" => 3,
        "medium" => 2,
        _ => 1,
    };

    if count < required && task.processing_mode != "single" {
        return Ok((
            StatusCode::OK,
            Json(json!({ "status": "pending", "received": count, "required": required })),
        ));
    }

    let results: Vec<String> = entry
        .iter()
        .filter_map(|r| r.get("result").and_then(|v| v.as_str()).map(str::to_string))
        .collect();

    let (final_result, mut verification) = if results.len() > 1 {
        let exact_match = results.iter().all(|r| r == &results[0]);
        if exact_match {
            (
                results[0].clone(),
                json!({ "method": "exact_match", "nodes": results.len() }),
            )
        } else {
            let mut best = results[0].clone();
            let mut best_score = 0.0f64;
            for candidate in &results {
                let scores: Vec<f64> = results
                    .iter()
                    .map(|r| semantic_similarity(candidate, r))
                    .collect();
                let avg = scores.iter().sum::<f64>() / scores.len() as f64;
                if avg > best_score {
                    best_score = avg;
                    best = candidate.clone();
                }
            }
            if best_score < 0.3 {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(json!({ "error": "Results failed consensus verification" })),
                ));
            }
            (
                best,
                json!({
                    "method": "semantic_consensus",
                    "similarity": best_score,
                    "nodes": results.len()
                }),
            )
        }
    } else {
        (
            result.clone(),
            json!({ "method": "signature_and_hash", "nodes": 1 }),
        )
    };

    if let Some(obj) = verification.as_object_mut() {
        obj.insert(
            "winning_node_address".into(),
            json!(data.node_address),
        );
        obj.insert("duration_ms".into(), json!(duration_ms));
    }

    if let Some(node_id) = &data.node_id {
        let node_list = state.nodes.list_nodes().await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;
        if let Some(node) = node_list.iter().find(|n| {
            n.get("node_id").and_then(|v| v.as_str()) == Some(node_id.as_str())
        }) {
            let rep = node.get("reputation").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let new_rep = update_reputation(rep, true, duration_ms);
            let _ = state.nodes.update_reputation(node_id, new_rep).await;
        }
    }

    existing.remove(&task_id);
    drop(existing);

    finalize_task(&state, &task_id, &final_result, verification)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;

    Ok((
        StatusCode::OK,
        Json(json!({ "status": "verified", "task_id": task_id })),
    ))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3003);

    let pool = create_pool(None).await?;
    migrate(&pool).await?;

    let validator_wallet = create_wallet();
    WalletRepository::new(pool.clone())
        .upsert_wallet(&validator_wallet.address, &validator_wallet.public_key)
        .await?;

    let validator = Validator {
        id: "validator-1".into(),
        public_key: validator_wallet.public_key.clone(),
        wallet: validator_wallet.clone(),
        stake: None,
    };
    let chain_state = create_blockchain(vec![validator]);

    info!("Validator wallet: {}", validator_wallet.address);

    let state = Arc::new(AppState {
        pool: pool.clone(),
        tasks: TaskRepository::new(pool.clone()),
        wallets: WalletRepository::new(pool.clone()),
        nodes: noetis_db::NodeRepository::new(pool.clone()),
        blocks: BlockRepository::new(pool.clone()),
        progress: ProgressRepository::new(pool.clone()),
        chain: Mutex::new(chain_state),
        validator_wallet,
        task_results: Mutex::new(HashMap::new()),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/internal/verify", post(internal_verify))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    info!("Validator listening on :{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
