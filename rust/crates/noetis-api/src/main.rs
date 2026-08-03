mod scheduler;

use anyhow::Result;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use noetis_crypto::{
    create_wallet, estimate_tokens, hash_str, verify_auth_challenge, wallet_from_private_key,
};
use noetis_currency::{estimate_task_price, PriceEstimateInput, FAUCET_AMOUNT};
use noetis_db::{
    create_pool, migrate, CreateTaskInput, NodeRepository, ProgressRepository, TaskRepository,
    WalletRepository,
};
use noetis_protocol::{
    CreateTaskRequest, ProcessingMode, TaskStatus, VerificationLevel,
};
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use scheduler::{select_nodes, SchedulableNode};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashSet;
use std::env;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::{error, info};
use uuid::Uuid;

struct AppState {
    pool: PgPool,
    tasks: TaskRepository,
    wallets: WalletRepository,
    nodes: NodeRepository,
    progress: ProgressRepository,
    redis: Option<ConnectionManager>,
    used_nonces: Mutex<HashSet<String>>,
    coordinator_url: String,
    full_node_url: String,
    internal_token: String,
    heartbeat_timeout_ms: i64,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct FaucetBody {
    address: Option<String>,
}

#[derive(Deserialize)]
struct ImportWalletBody {
    private_key: Option<String>,
}

#[derive(Deserialize)]
struct TaskQuery {
    wallet: Option<String>,
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "noetis-api" }))
}

async fn create_wallet_handler(State(state): State<Arc<AppState>>) -> Result<Json<Value>, StatusCode> {
    let wallet = create_wallet();
    state
        .wallets
        .upsert_wallet(&wallet.address, &wallet.public_key)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({
        "address": wallet.address,
        "public_key": wallet.public_key,
        "private_key": wallet.private_key,
        "note": "Store private_key securely. Never share it."
    })))
}

async fn import_wallet(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ImportWalletBody>,
) -> Result<Json<Value>, StatusCode> {
    let pk = body.private_key.ok_or(StatusCode::BAD_REQUEST)?;
    let wallet = wallet_from_private_key(&pk, None);
    state
        .wallets
        .upsert_wallet(&wallet.address, &wallet.public_key)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({
        "address": wallet.address,
        "public_key": wallet.public_key
    })))
}

async fn get_wallet(
    State(state): State<Arc<AppState>>,
    Path(address): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let wallet = state
        .wallets
        .get_wallet(&address)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let on_chain = chain_balance(&state, &address).await;
    Ok(Json(json!({
        "address": wallet.address,
        "public_key": wallet.public_key,
        "balance": on_chain.unwrap_or(wallet.balance),
        "chain_verified": on_chain.is_some()
    })))
}

async fn chain_balance(state: &AppState, address: &str) -> Option<f64> {
    let res = state
        .http
        .get(format!("{}/chain/balance/{}", state.full_node_url, address))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let data: Value = res.json().await.ok()?;
    data.get("balance").and_then(|v| v.as_f64())
}

async fn gossip_tx(state: &AppState, tx: Value) {
    let _ = state
        .http
        .post(format!("{}/tx", state.full_node_url))
        .json(&tx)
        .send()
        .await;
}

async fn faucet(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FaucetBody>,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let address = body.address.ok_or(StatusCode::BAD_REQUEST)?;
    if state
        .wallets
        .get_wallet(&address)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_none()
    {
        state
            .wallets
            .upsert_wallet(&address, "")
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    let new_balance = state
        .wallets
        .increment_balance(&address, FAUCET_AMOUNT)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    gossip_tx(
        &state,
        json!({
            "id": Uuid::new_v4().to_string(),
            "type": "FAUCET_TRANSFER",
            "from": "faucet-dev-only",
            "to": address,
            "amount": FAUCET_AMOUNT,
            "metadata": { "note": "DEVELOPMENT ONLY" },
            "timestamp": chrono_timestamp_ms()
        }),
    )
    .await;

    if let Some(ref mut redis) = state.redis.clone() {
        let _: Result<i32, _> = redis
            .publish(
                "ledger:tx",
                serde_json::to_string(&json!({
                    "type": "FAUCET_TRANSFER",
                    "address": address,
                    "amount": FAUCET_AMOUNT
                }))
                .unwrap_or_default(),
            )
            .await;
    }

    Ok((
        StatusCode::OK,
        Json(json!({
            "amount": FAUCET_AMOUNT,
            "balance": new_balance,
            "warning": "DEVELOPMENT ONLY — test NOET (NOET) has no real monetary value."
        })),
    ))
}

fn chrono_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

async fn check_nonce(state: &AppState, wallet: &str, nonce: &str) -> Result<(), StatusCode> {
    let key = format!("nonce:{wallet}:{nonce}");
    if let Some(ref mut redis) = state.redis.clone() {
        let set: bool = redis::cmd("SET")
            .arg(&key)
            .arg("1")
            .arg("EX")
            .arg(600)
            .arg("NX")
            .query_async(redis)
            .await
            .unwrap_or(false);
        if !set {
            return Err(StatusCode::CONFLICT);
        }
        return Ok(());
    }
    let mut nonces = state.used_nonces.lock().await;
    if !nonces.insert(key) {
        return Err(StatusCode::CONFLICT);
    }
    Ok(())
}

fn verification_str(v: &VerificationLevel) -> &'static str {
    match v {
        VerificationLevel::Low => "low",
        VerificationLevel::Medium => "medium",
        VerificationLevel::High => "high",
    }
}

fn mode_str(m: &ProcessingMode) -> &'static str {
    match m {
        ProcessingMode::Single => "single",
        ProcessingMode::Redundant => "redundant",
        ProcessingMode::Subtask => "subtask",
    }
}

async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateTaskRequest>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let wallet_rec = state
        .wallets
        .get_wallet(&body.wallet_address)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?
        .ok_or((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Wallet not found" })),
        ))?;

    let auth_ok = verify_auth_challenge(
        &noetis_crypto::AuthChallenge {
            wallet_address: body.wallet_address.clone(),
            timestamp: body.timestamp,
            nonce: body.nonce.clone(),
        },
        &body.signature,
        &wallet_rec.public_key,
        300_000,
    );
    if !auth_ok {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid signature or expired challenge" })),
        ));
    }

    check_nonce(&state, &body.wallet_address, &body.nonce)
        .await
        .map_err(|_| {
            (
                StatusCode::CONFLICT,
                Json(json!({ "error": "Replay detected: nonce already used" })),
            )
        })?;

    let node_list = state.nodes.list_nodes().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
    })?;

    let now = chrono_timestamp_ms();
    let online_nodes: Vec<SchedulableNode> = node_list
        .iter()
        .filter_map(|n| {
            let last = n
                .get("last_heartbeat")
                .and_then(|v| v.as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis())
                .unwrap_or(0);
            if now - last >= state.heartbeat_timeout_ms {
                return None;
            }
            Some(SchedulableNode {
                node_id: n.get("node_id")?.as_str()?.to_string(),
                wallet_address: n.get("wallet_address")?.as_str()?.to_string(),
                public_key: n.get("public_key")?.as_str()?.to_string(),
                box_public_key: n.get("metadata")
                    .and_then(|m| m.get("box_public_key"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                models: n.get("models").cloned().unwrap_or(json!([])),
                cpu: n.get("cpu").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                gpu: n.get("gpu").and_then(|v| v.as_str()).map(str::to_string),
                ram_gb: n.get("ram_gb").and_then(|v| v.as_f64()).unwrap_or(0.0),
                price_per_input_token: n
                    .get("price_per_input_token")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.00001),
                price_per_output_token: n
                    .get("price_per_output_token")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.00003),
                maximum_parallel_tasks: n
                    .get("maximum_parallel_tasks")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(2) as i32,
                reputation: n.get("reputation").and_then(|v| v.as_f64()).unwrap_or(0.0),
                status: n.get("status").and_then(|v| v.as_str()).unwrap_or("offline").to_string(),
                accepts_redundant: true,
                current_tasks: 0,
                avg_latency_ms: 2000.0,
                success_rate: 0.9,
            })
        })
        .collect();

    let input_tokens = estimate_tokens(&body.prompt);
    let avg_input = if online_nodes.is_empty() {
        0.00001
    } else {
        online_nodes.iter().map(|n| n.price_per_input_token).sum::<f64>()
            / online_nodes.len() as f64
    };
    let avg_output = if online_nodes.is_empty() {
        0.00003
    } else {
        online_nodes.iter().map(|n| n.price_per_output_token).sum::<f64>()
            / online_nodes.len() as f64
    };

    let node_count = match (&body.processing_mode, &body.verification_level) {
        (ProcessingMode::Redundant, _) => 3,
        (_, VerificationLevel::High) => 3,
        (_, VerificationLevel::Medium) => 2,
        _ => 1,
    };

    let estimated_price = estimate_task_price(&PriceEstimateInput {
        input_tokens,
        max_output_tokens: body.max_output_tokens as i64,
        model: body.model.clone(),
        node_count,
        verification_level: verification_str(&body.verification_level).to_string(),
        node_input_price: avg_input,
        node_output_price: avg_output,
    });

    if wallet_rec.balance < estimated_price {
        return Err((
            StatusCode::PAYMENT_REQUIRED,
            Json(json!({
                "error": "Insufficient NOET balance",
                "required": estimated_price,
                "balance": wallet_rec.balance
            })),
        ));
    }

    let selected = select_nodes(
        &online_nodes,
        &body.model,
        estimated_price,
        &body.processing_mode,
        &body.verification_level,
    );

    if selected.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "No compatible online nodes available for this model" })),
        ));
    }

    let task_id = Uuid::new_v4();
    let prompt_hash = hash_str(&body.prompt);

    state
        .wallets
        .increment_balance(&body.wallet_address, -estimated_price)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;

    sqlx::query("INSERT INTO escrows (task_id, user_address, locked_amount) VALUES ($1, $2, $3)")
        .bind(task_id)
        .bind(&body.wallet_address)
        .bind(estimated_price)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;

    state
        .tasks
        .create_task(CreateTaskInput {
            id: task_id,
            user_address: body.wallet_address.clone(),
            model: body.model.clone(),
            prompt_hash: prompt_hash.clone(),
            max_output_tokens: body.max_output_tokens,
            verification_level: verification_str(&body.verification_level).to_string(),
            processing_mode: mode_str(&body.processing_mode).to_string(),
            estimated_price,
            status: "created".into(),
            node_addresses: selected.iter().map(|n| n.wallet_address.clone()).collect(),
        })
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;

    state
        .progress
        .add_event(task_id, TaskStatus::Created, None)
        .await
        .ok();
    state
        .progress
        .add_event(
            task_id,
            TaskStatus::PriceEstimated,
            Some(&format!("Estimated {estimated_price} NOET")),
        )
        .await
        .ok();
    state
        .progress
        .add_event(task_id, TaskStatus::EscrowLocked, None)
        .await
        .ok();
    state
        .progress
        .add_event(
            task_id,
            TaskStatus::NodesFound,
            Some(&format!("{} node(s)", selected.len())),
        )
        .await
        .ok();
    state
        .progress
        .add_event(
            task_id,
            TaskStatus::NodeSelected,
            Some(&selected.iter().map(|n| n.node_id.as_str()).collect::<Vec<_>>().join(", ")),
        )
        .await
        .ok();
    state
        .tasks
        .update_status(
            task_id,
            TaskStatus::NodeSelected,
            noetis_db::TaskUpdateExtra {
                node_addresses: Some(
                    &selected
                        .iter()
                        .map(|n| n.wallet_address.clone())
                        .collect::<Vec<_>>(),
                ),
                ..Default::default()
            },
        )
        .await
        .ok();

    if let Some(ref mut redis) = state.redis.clone() {
        let _: Result<(), _> = redis
            .set_ex(
                format!("task:prompt:{task_id}"),
                &body.prompt,
                3600,
            )
            .await;
    }

    let _ = state
        .http
        .post(format!("{}/task-offer", state.full_node_url))
        .json(&json!({
            "task_id": task_id,
            "prompt_hash": prompt_hash,
            "model": body.model,
            "max_output_tokens": body.max_output_tokens,
            "verification_level": verification_str(&body.verification_level),
            "processing_mode": mode_str(&body.processing_mode),
            "estimated_price": estimated_price,
            "user_address": body.wallet_address,
            "assigned_nodes": selected.iter().map(|n| &n.node_id).collect::<Vec<_>>()
        }))
        .send()
        .await;

    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    if !state.internal_token.is_empty() {
        headers.insert(
            "x-noetis-internal-token",
            state.internal_token.parse().unwrap(),
        );
    }
    let _ = state
        .http
        .post(format!("{}/internal/dispatch", state.coordinator_url))
        .headers(headers)
        .json(&json!({
            "task_id": task_id,
            "prompt": body.prompt,
            "model": body.model,
            "max_output_tokens": body.max_output_tokens,
            "verification_level": verification_str(&body.verification_level),
            "processing_mode": mode_str(&body.processing_mode),
            "nodes": selected.iter().map(|n| json!({
                "node_id": n.node_id,
                "public_key": n.public_key,
                "box_public_key": n.box_public_key,
                "wallet_address": n.wallet_address
            })).collect::<Vec<_>>(),
            "user_address": body.wallet_address,
            "estimated_price": estimated_price
        }))
        .send()
        .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "task_id": task_id,
            "estimated_price": estimated_price,
            "prompt_hash": prompt_hash,
            "nodes": selected.iter().map(|n| &n.node_id).collect::<Vec<_>>(),
            "status": "node_selected"
        })),
    ))
}

async fn list_tasks(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TaskQuery>,
) -> Result<Json<Value>, StatusCode> {
    let list = state
        .tasks
        .list_tasks(q.wallet.as_deref(), 30)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let out: Vec<Value> = list
        .into_iter()
        .map(|t| {
            json!({
                "id": t.id,
                "user_address": t.user_address,
                "model": t.model,
                "prompt_hash": t.prompt_hash,
                "result_hash": t.result_hash,
                "result_text": t.result_text,
                "max_output_tokens": t.max_output_tokens,
                "verification_level": t.verification_level,
                "processing_mode": t.processing_mode,
                "estimated_price": t.estimated_price,
                "actual_price": t.actual_price,
                "status": t.status,
                "node_addresses": t.node_addresses,
                "verification_result": t.verification_result,
                "created_at": t.created_at,
                "updated_at": t.updated_at
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

async fn get_task(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let id = Uuid::parse_str(&task_id).map_err(|_| StatusCode::BAD_REQUEST)?;
    let task = state
        .tasks
        .get_task(id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let events = state
        .progress
        .list_events(id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let progress: Vec<Value> = events
        .into_iter()
        .map(|e| {
            json!({
                "status": e.status,
                "message": e.message,
                "created_at": e.created_at
            })
        })
        .collect();
    Ok(Json(json!({
        "id": task.id,
        "user_address": task.user_address,
        "model": task.model,
        "status": task.status,
        "estimated_price": task.estimated_price,
        "result_hash": task.result_hash,
        "result_text": task.result_text,
        "verification_result": task.verification_result,
        "progress": progress
    })))
}

async fn task_result(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let id = Uuid::parse_str(&task_id).map_err(|_| StatusCode::BAD_REQUEST)?;
    let task = state
        .tasks
        .get_task(id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if task.result_text.is_none() {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "status": task.status, "message": "Result not ready" })),
        ));
    }
    Ok((
        StatusCode::OK,
        Json(json!({
            "task_id": task.id,
            "result": task.result_text,
            "result_hash": task.result_hash,
            "status": task.status,
            "verification_result": task.verification_result
        })),
    ))
}

async fn list_nodes(State(state): State<Arc<AppState>>) -> Result<Json<Value>, StatusCode> {
    let list = state
        .nodes
        .list_nodes()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!(list)))
}

async fn network_stats(State(state): State<Arc<AppState>>) -> Result<Json<Value>, StatusCode> {
    let total_nodes = state.nodes.list_nodes().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.len() as i32;
    let online_nodes = state
        .nodes
        .count_online(state.heartbeat_timeout_ms)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let total_tasks = state.tasks.count_tasks().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let completed_tasks = state.tasks.count_completed().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let total_noet = state.wallets.total_supply().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let block_height = noetis_db::BlockRepository::new(state.pool.clone())
        .get_height()
        .await
        .unwrap_or(0);
    Ok(Json(json!({
        "total_nodes": total_nodes,
        "online_nodes": online_nodes,
        "total_tasks": total_tasks,
        "completed_tasks": completed_tasks,
        "total_noet_supply": total_noet,
        "block_height": block_height
    })))
}

async fn chain(State(state): State<Arc<AppState>>) -> Json<Value> {
    if let Ok(res) = state.http.get(format!("{}/chain", state.full_node_url)).send().await {
        if res.status().is_success() {
            if let Ok(data) = res.json().await {
                return Json(data);
            }
        }
    }
    let blocks = noetis_db::BlockRepository::new(state.pool.clone())
        .list_blocks(20)
        .await
        .unwrap_or_default();
    Json(json!({ "chain": blocks }))
}

async fn peers(State(state): State<Arc<AppState>>) -> Json<Value> {
    if let Ok(res) = state.http.get(format!("{}/peers", state.full_node_url)).send().await {
        if res.status().is_success() {
            if let Ok(data) = res.json().await {
                return Json(data);
            }
        }
    }
    Json(json!([]))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let port: u16 = env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3001);
    let pool = create_pool(None).await?;
    migrate(&pool).await?;

    let redis_url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".into());
    let redis = match redis::Client::open(redis_url.as_str()) {
        Ok(client) => ConnectionManager::new(client).await.ok(),
        Err(_) => None,
    };

    let state = Arc::new(AppState {
        pool: pool.clone(),
        tasks: TaskRepository::new(pool.clone()),
        wallets: WalletRepository::new(pool.clone()),
        nodes: NodeRepository::new(pool.clone()),
        progress: ProgressRepository::new(pool.clone()),
        redis,
        used_nonces: Mutex::new(HashSet::new()),
        coordinator_url: env::var("COORDINATOR_INTERNAL_URL")
            .unwrap_or_else(|_| "http://localhost:3002".into()),
        full_node_url: env::var("FULL_NODE_URL")
            .unwrap_or_else(|_| "http://localhost:4000".into()),
        internal_token: env::var("INTERNAL_DISPATCH_TOKEN").unwrap_or_default(),
        heartbeat_timeout_ms: env::var("HEARTBEAT_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60_000),
        http: reqwest::Client::new(),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/wallets", post(create_wallet_handler))
        .route("/api/wallets/import", post(import_wallet))
        .route("/api/wallets/{address}", get(get_wallet))
        .route("/api/faucet", post(faucet))
        .route("/api/tasks", post(create_task).get(list_tasks))
        .route("/api/tasks/{task_id}", get(get_task))
        .route("/api/tasks/{task_id}/result", get(task_result))
        .route("/api/nodes", get(list_nodes))
        .route("/api/network/stats", get(network_stats))
        .route("/api/chain", get(chain))
        .route("/api/peers", get(peers))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    info!("Noetis API listening on :{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
