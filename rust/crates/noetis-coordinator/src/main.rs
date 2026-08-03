use anyhow::Result;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use noetis_crypto::{derive_node_id, encrypt_for_recipient, verify_payload_signature};
use noetis_db::{
    create_pool, migrate, NodeRepository, NodeUpsertInput, ProgressRepository, TaskRepository,
};
use noetis_protocol::{NodeRegistration, TaskStatus, WsMessage, WsMessageType};
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use uuid::Uuid;

mod scheduler;
use scheduler::decompose_subtasks;

struct ConnectedNode {
    conn_id: String,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
    node_id: String,
    public_key: String,
    wallet_address: String,
    registration: Value,
}

struct AppState {
    connections: Arc<RwLock<HashMap<String, ConnectedNode>>>,
    node_by_conn: Arc<RwLock<HashMap<String, String>>>,
    node_by_id: Arc<RwLock<HashMap<String, String>>>,
    pending_tasks: Arc<RwLock<HashMap<String, Value>>>,
    node_repo: NodeRepository,
    progress: ProgressRepository,
    _tasks: TaskRepository,
    redis: Option<ConnectionManager>,
    validator_url: String,
    internal_token: String,
    heartbeat_timeout_ms: i64,
    http: reqwest::Client,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn coordinator_msg(msg_type: WsMessageType, payload: Value) -> WsMessage {
    WsMessage {
        msg_type,
        message_id: Uuid::new_v4().to_string(),
        timestamp: now_ms(),
        sender: "coordinator".into(),
        payload,
        signature: "coordinator".into(),
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "noetis-coordinator" }))
}

#[derive(Deserialize, Serialize)]
struct DispatchBody {
    task_id: Option<String>,
    prompt: Option<String>,
    model: Option<String>,
    max_output_tokens: Option<i32>,
    verification_level: Option<String>,
    processing_mode: Option<String>,
    nodes: Option<Vec<Value>>,
    #[allow(dead_code)]
    user_address: Option<String>,
    estimated_price: Option<f64>,
}

async fn internal_dispatch(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(data): Json<DispatchBody>,
) -> Result<Json<Value>, StatusCode> {
    if !state.internal_token.is_empty() {
        let token = headers
            .get("x-noetis-internal-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if token != state.internal_token {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    let task_id = data.task_id.clone().unwrap_or_default();
    let data_val = serde_json::to_value(&data).unwrap_or(json!({}));
    state.pending_tasks.write().await.insert(task_id.clone(), data_val);

    let processing_mode = data.processing_mode.as_deref().unwrap_or("single");
    let prompt = data.prompt.clone().unwrap_or_default();
    let mut prompts = vec![prompt.clone()];
    if processing_mode == "subtask" {
        prompts = decompose_subtasks(&prompt);
    }

    let assigned = data.nodes.clone().unwrap_or_default();
    if let Ok(id) = Uuid::parse_str(&task_id) {
        let _ = state
            .progress
            .add_event(id, TaskStatus::PromptDelivered, None)
            .await;
    }

    let node_ids: Vec<String> = assigned
        .iter()
        .filter_map(|n| n.get("node_id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    let id_map = state.node_by_id.read().await;

    for (i, node_info) in assigned.iter().enumerate() {
        let node_id = node_info
            .get("node_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let Some(conn_id) = id_map.get(node_id) else {
            continue;
        };
        let conns = state.connections.read().await;
        let Some(conn) = conns.get(conn_id) else {
            continue;
        };

        let prompt_text = prompts.get(i).or(prompts.first()).cloned().unwrap_or_default();
        let box_pk = node_info
            .get("box_public_key")
            .and_then(|v| v.as_str())
            .or_else(|| node_info.get("public_key").and_then(|v| v.as_str()))
            .unwrap_or("");

        let encrypted = encrypt_for_recipient(
            &serde_json::to_string(&json!({
                "task_id": task_id,
                "prompt": prompt_text,
                "model": data.model,
                "max_output_tokens": data.max_output_tokens,
                "subtask_index": i,
                "subtask_total": assigned.len()
            }))
            .unwrap_or_default(),
            box_pk,
        );

        let reward = data.estimated_price.unwrap_or(0.0) / assigned.len().max(1) as f64;
        let payload = json!({
            "task_id": task_id,
            "encrypted": encrypted,
            "model": data.model,
            "estimated_reward": reward
        });
        let msg = coordinator_msg(WsMessageType::TaskPayload, payload);
        let _ = conn.tx.send(serde_json::to_string(&msg).unwrap());
    }
    let _ = node_ids;

    Ok(Json(json!({ "dispatched": true })))
}

fn registration_to_upsert(reg: &NodeRegistration, node_id: &str, status: &str) -> NodeUpsertInput {
    NodeUpsertInput {
        node_id: node_id.to_string(),
        wallet_address: reg.wallet_address.clone(),
        public_key: reg.public_key.clone(),
        models: serde_json::to_value(&reg.models).unwrap_or(json!([])),
        cpu: Some(reg.cpu.clone()),
        gpu: reg.gpu.clone(),
        ram_gb: Some(reg.ram_gb),
        vram_gb: reg.vram_gb,
        operating_system: Some(reg.operating_system.clone()),
        price_per_input_token: reg.price_per_input_token,
        price_per_output_token: reg.price_per_output_token,
        maximum_parallel_tasks: reg.maximum_parallel_tasks,
        reputation: reg.reputation,
        status: status.to_string(),
        metadata: json!({
            "box_public_key": reg.box_public_key,
            "accepts_redundant": reg.accepts_redundant,
            "minimum_task_payment": reg.minimum_task_payment
        }),
    }
}

async fn handle_ws_message(state: Arc<AppState>, text: String, conn_id: &str, reply_tx: &tokio::sync::mpsc::UnboundedSender<String>) {
    let parsed: WsMessage = match serde_json::from_str(&text) {
        Ok(m) => m,
        Err(_) => {
            let msg = coordinator_msg(WsMessageType::Error, json!({ "error": "Invalid message schema" }));
            let _ = reply_tx.send(serde_json::to_string(&msg).unwrap());
            return;
        }
    };

    if parsed.msg_type == WsMessageType::NodeRegister {
        let reg: NodeRegistration = match serde_json::from_value(parsed.payload.clone()) {
            Ok(r) => r,
            Err(_) => {
                let msg = coordinator_msg(WsMessageType::Error, json!({ "error": "Invalid registration" }));
                let _ = reply_tx.send(serde_json::to_string(&msg).unwrap());
                return;
            }
        };

        let payload_map: BTreeMap<String, Value> = parsed
            .payload
            .as_object()
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();

        if !verify_payload_signature(&payload_map, &parsed.signature, &reg.public_key) {
            let msg = coordinator_msg(WsMessageType::Error, json!({ "error": "Invalid registration signature" }));
            let _ = reply_tx.send(serde_json::to_string(&msg).unwrap());
            return;
        }

        let node_id = derive_node_id(&reg.public_key);
        let mut reg_val = serde_json::to_value(&reg).unwrap_or(json!({}));
        if let Some(obj) = reg_val.as_object_mut() {
            obj.insert("node_id".into(), json!(node_id));
        }

        let conn = ConnectedNode {
            conn_id: conn_id.to_string(),
            tx: reply_tx.clone(),
            node_id: node_id.clone(),
            public_key: reg.public_key.clone(),
            wallet_address: reg.wallet_address.clone(),
            registration: reg_val,
        };
        state.connections.write().await.insert(conn_id.to_string(), conn);
        state.node_by_conn.write().await.insert(conn_id.to_string(), node_id.clone());
        state.node_by_id.write().await.insert(node_id.clone(), conn_id.to_string());

        let upsert = registration_to_upsert(&reg, &node_id, "available");
        if let Err(e) = state.node_repo.upsert_node(upsert).await {
            error!("upsert node: {}", e);
        }

        if let Some(ref mut redis) = state.redis.clone() {
            let _: Result<(), _> = redis
                .set_ex(
                    format!("node:online:{node_id}"),
                    "1",
                    (state.heartbeat_timeout_ms / 1000).max(1) as u64,
                )
                .await;
        }

        let reply = coordinator_msg(
            WsMessageType::Registered,
            json!({ "node_id": node_id, "status": "registered" }),
        );
        let _ = reply_tx.send(serde_json::to_string(&reply).unwrap());
        return;
    }

    let node_id = state.node_by_conn.read().await.get(conn_id).cloned();
    let Some(node_id) = node_id else {
        return;
    };

    match parsed.msg_type {
        WsMessageType::NodeHeartbeat => {
            let status = parsed
                .payload
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("available");
            let reg = {
                let mut conns = state.connections.write().await;
                if let Some(conn) = conns.get_mut(conn_id) {
                    if let Some(obj) = conn.registration.as_object_mut() {
                        obj.insert("status".into(), json!(status));
                    }
                    conn.registration.clone()
                } else {
                    return;
                }
            };
            if let Ok(node_reg) = serde_json::from_value::<NodeRegistration>(reg) {
                let upsert = registration_to_upsert(&node_reg, &node_id, status);
                let _ = state.node_repo.upsert_node(upsert).await;
            }
            if let Some(ref mut redis) = state.redis.clone() {
                let _: Result<(), _> = redis
                    .set_ex(
                        format!("node:online:{node_id}"),
                        "1",
                        (state.heartbeat_timeout_ms / 1000).max(1) as u64,
                    )
                    .await;
            }
        }
        WsMessageType::TaskAccept => {
            if let Ok(id) = Uuid::parse_str(
                parsed.payload.get("task_id").and_then(|v| v.as_str()).unwrap_or(""),
            ) {
                let _ = state
                    .progress
                    .add_event(id, TaskStatus::InferenceStarted, None)
                    .await;
            }
        }
        WsMessageType::TaskResult => {
            let task_id = parsed
                .payload
                .get("task_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Ok(id) = Uuid::parse_str(&task_id) {
                let _ = state
                    .progress
                    .add_event(id, TaskStatus::ResultReturned, None)
                    .await;
            }
            let (wallet, pk) = {
                let conns = state.connections.read().await;
                if let Some(conn) = conns.get(conn_id) {
                    (conn.wallet_address.clone(), conn.public_key.clone())
                } else {
                    return;
                }
            };

            let _ = state
                .http
                .post(format!("{}/internal/verify", state.validator_url))
                .json(&json!({
                    "task_id": task_id,
                    "node_id": node_id,
                    "node_address": wallet,
                    "result": parsed.payload.get("result"),
                    "result_hash": parsed.payload.get("result_hash"),
                    "signature": parsed.signature,
                    "public_key": pk,
                    "duration_ms": parsed.payload.get("duration_ms"),
                    "input_tokens": parsed.payload.get("input_tokens"),
                    "output_tokens": parsed.payload.get("output_tokens")
                }))
                .send()
                .await;
        }
        _ => {}
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(state, socket))
}

async fn handle_socket(state: Arc<AppState>, socket: WebSocket) {
    let conn_id = Uuid::new_v4().to_string();
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let write_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                handle_ws_message(state.clone(), text.to_string(), &conn_id, &tx).await;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    if let Some(node_id) = state.node_by_conn.read().await.get(&conn_id).cloned() {
        state.node_by_id.write().await.remove(&node_id);
        if let Some(conn) = state.connections.write().await.remove(&conn_id) {
            if let Ok(node_reg) = serde_json::from_value::<NodeRegistration>(conn.registration) {
                let upsert = registration_to_upsert(&node_reg, &node_id, "offline");
                let _ = state.node_repo.upsert_node(upsert).await;
            }
        }
        state.node_by_conn.write().await.remove(&conn_id);
    } else {
        state.connections.write().await.remove(&conn_id);
    }

    write_task.abort();
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let port: u16 = env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3002);
    let pool = create_pool(None).await?;
    migrate(&pool).await?;

    let redis_url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".into());
    let redis = match redis::Client::open(redis_url.as_str()) {
        Ok(client) => ConnectionManager::new(client).await.ok(),
        Err(_) => None,
    };

    let state = Arc::new(AppState {
        connections: Arc::new(RwLock::new(HashMap::new())),
        node_by_conn: Arc::new(RwLock::new(HashMap::new())),
        node_by_id: Arc::new(RwLock::new(HashMap::new())),
        pending_tasks: Arc::new(RwLock::new(HashMap::new())),
        node_repo: NodeRepository::new(pool.clone()),
        progress: ProgressRepository::new(pool.clone()),
        _tasks: TaskRepository::new(pool.clone()),
        redis,
        validator_url: env::var("VALIDATOR_URL").unwrap_or_else(|_| "http://localhost:3003".into()),
        internal_token: env::var("INTERNAL_DISPATCH_TOKEN").unwrap_or_default(),
        heartbeat_timeout_ms: env::var("HEARTBEAT_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60_000),
        http: reqwest::Client::new(),
    });

    let heartbeat_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            if let Ok(all) = heartbeat_state.node_repo.list_nodes().await {
                let now = now_ms();
                for n in all {
                    let last = n
                        .get("last_heartbeat")
                        .and_then(|v| v.as_str())
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.timestamp_millis())
                        .unwrap_or(0);
                    if now - last > heartbeat_state.heartbeat_timeout_ms {
                        if let Some(node_id) = n.get("node_id").and_then(|v| v.as_str()) {
                            if let Ok(reg) = serde_json::from_value::<NodeRegistration>(n.clone()) {
                                let upsert = registration_to_upsert(&reg, node_id, "offline");
                                let _ = heartbeat_state.node_repo.upsert_node(upsert).await;
                            }
                        }
                    }
                }
            }
        }
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/internal/dispatch", post(internal_dispatch))
        .route("/ws", get(ws_handler))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    info!("Coordinator HTTP+WS on :{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
