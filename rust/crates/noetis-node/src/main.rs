use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use futures_util::{SinkExt, StreamExt};
use noetis_crypto::{
    decrypt_from_sender, derive_node_id, hash_str, sign_payload, wallet_from_private_key, Wallet,
};
use noetis_currency::NODE_STAKE_AMOUNT;
use noetis_p2p::GossipNetwork;
use noetis_protocol::{P2pMessageType, WsMessage, WsMessageType};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "noetis-node")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Start(StartArgs),
}

#[derive(Parser, Clone)]
struct StartArgs {
    #[arg(long, default_value = "ws://localhost:3002/ws")]
    coordinator: String,
    #[arg(long, default_value = "./data/wallet.json")]
    wallet: String,
    #[arg(long, default_value = "http://localhost:11434")]
    ollama: String,
    #[arg(long, default_value = "")]
    p2p_bootstrap: String,
    #[arg(long, default_value = "4010")]
    p2p_port: u16,
    #[arg(long, default_value = "0.00001")]
    input_price: f64,
    #[arg(long, default_value = "0.00003")]
    output_price: f64,
    #[arg(long, default_value = "2")]
    max_tasks: i32,
    #[arg(long)]
    models: Option<String>,
}

#[derive(Deserialize)]
struct WalletFile {
    private_key: String,
    #[serde(default)]
    box_secret_key: Option<String>,
}

#[derive(Default)]
struct NodeStats {
    completed: u64,
    failed: u64,
    earned: f64,
    uptime_start: i64,
}

struct OllamaModel {
    name: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn load_wallet(path: &str) -> Result<Wallet> {
    let path = PathBuf::from(path);
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let w = noetis_crypto::create_wallet();
        let data = json!({
            "address": w.address,
            "public_key": w.public_key,
            "private_key": w.private_key,
            "box_public_key": w.box_public_key,
            "box_secret_key": hex::encode(w.box_secret_key.to_bytes()),
        });
        fs::write(&path, serde_json::to_string_pretty(&data)?)?;
        info!("Created new wallet at {}: {}", path.display(), w.address);
        return Ok(w);
    }
    let raw = fs::read_to_string(&path)?;
    let file: WalletFile = serde_json::from_str(&raw)?;
    Ok(wallet_from_private_key(
        &file.private_key,
        file.box_secret_key.as_deref(),
    ))
}

fn to_ws_url(coordinator: &str) -> String {
    if coordinator.starts_with("ws://") || coordinator.starts_with("wss://") {
        return coordinator.to_string();
    }
    let base = coordinator.trim_end_matches('/');
    if base.ends_with("/ws") {
        if base.starts_with("http") {
            return base.replace("https://", "wss://").replace("http://", "ws://");
        }
        return base.to_string();
    }
    if coordinator.starts_with("https://") {
        format!("{}/ws", coordinator.trim_end_matches('/').replace("https://", "wss://"))
    } else if coordinator.starts_with("http://") {
        format!("{}/ws", coordinator.trim_end_matches('/').replace("http://", "ws://"))
    } else {
        format!("ws://{}/ws", coordinator.trim_matches('/'))
    }
}

async fn ollama_health(url: &str) -> bool {
    reqwest::Client::new()
        .get(format!("{}/api/tags", url.trim_end_matches('/')))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn ollama_list_models(url: &str) -> Vec<Value> {
    let Ok(res) = reqwest::Client::new()
        .get(format!("{}/api/tags", url.trim_end_matches('/')))
        .send()
        .await
    else {
        return vec![];
    };
    let Ok(data) = res.json::<Value>().await else {
        return vec![];
    };
    data.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let name = m.get("name")?.as_str()?.to_string();
                    Some(json!({
                        "name": name,
                        "model_hash": name,
                        "context_length": 8192
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn ollama_generate(
    url: &str,
    model: &str,
    prompt: &str,
    max_tokens: i32,
) -> Result<(String, i64, i64, i64)> {
    let start = now_ms();
    let body = json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "options": {
            "num_predict": max_tokens,
            "temperature": 0,
            "seed": 42
        }
    });
    let res = reqwest::Client::new()
        .post(format!("{}/api/generate", url.trim_end_matches('/')))
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    let data: Value = res.json().await?;
    let response = data
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let duration_ms = now_ms() - start;
    let input_tokens = noetis_crypto::estimate_tokens(prompt);
    let output_tokens = noetis_crypto::estimate_tokens(&response);
    Ok((response, duration_ms, input_tokens, output_tokens))
}

fn make_ws_message(
    msg_type: WsMessageType,
    sender: &str,
    payload: BTreeMap<String, Value>,
    wallet: &Wallet,
) -> WsMessage {
    WsMessage {
        msg_type,
        message_id: Uuid::new_v4().to_string(),
        timestamp: now_ms(),
        sender: sender.to_string(),
        payload: serde_json::to_value(&payload).unwrap_or(json!({})),
        signature: sign_payload(&payload, wallet),
    }
}

async fn register_node(
    ws_tx: &tokio::sync::mpsc::UnboundedSender<String>,
    wallet: &Wallet,
    node_id: &str,
    config: &StartArgs,
    enabled_models: &[String],
) -> Result<()> {
    let ollama_ok = ollama_health(&config.ollama).await;
    if !ollama_ok {
        warn!("WARNING: Ollama not reachable at {}", config.ollama);
    }

    let mut models = ollama_list_models(&config.ollama).await;
    if !enabled_models.is_empty() {
        models.retain(|m| {
            let name = m.get("name").and_then(|v| v.as_str()).unwrap_or("");
            enabled_models.iter().any(|e| name.contains(e))
        });
    }
    if models.is_empty() {
        warn!("No Ollama models found. Pull a model: ollama pull llama3.2:3b");
    }

    let mut payload = BTreeMap::new();
    payload.insert("node_id".into(), json!(node_id));
    payload.insert("wallet_address".into(), json!(wallet.address));
    payload.insert("public_key".into(), json!(wallet.public_key));
    payload.insert("box_public_key".into(), json!(wallet.box_public_key));
    payload.insert("models".into(), json!(models));
    payload.insert("cpu".into(), json!(std::env::consts::ARCH));
    payload.insert("gpu".into(), Value::Null);
    payload.insert("ram_gb".into(), json!(8.0));
    payload.insert("operating_system".into(), json!(std::env::consts::OS));
    payload.insert("price_per_input_token".into(), json!(config.input_price));
    payload.insert("price_per_output_token".into(), json!(config.output_price));
    payload.insert("maximum_parallel_tasks".into(), json!(config.max_tasks));
    payload.insert("reputation".into(), json!(0));
    payload.insert("status".into(), json!("available"));
    payload.insert("accepts_redundant".into(), json!(true));
    payload.insert("minimum_task_payment".into(), json!(0));

    let msg = make_ws_message(WsMessageType::NodeRegister, &wallet.public_key, payload, wallet);
    ws_tx.send(serde_json::to_string(&msg)?)?;
    info!("Registered node {} with {} model(s)", node_id, models.len());
    Ok(())
}

async fn process_task(
    ws_tx: &tokio::sync::mpsc::UnboundedSender<String>,
    wallet: &Wallet,
    config: &StartArgs,
    payload: &Value,
    stats: &Arc<RwLock<NodeStats>>,
) {
    let task_id = payload.get("task_id").and_then(|v| v.as_str()).unwrap_or("");
    let model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("llama3.2:3b");
    let encrypted = payload.get("encrypted");

    let result = async {
        let enc = encrypted.context("missing encrypted payload")?;
        let ciphertext = enc.get("ciphertext").and_then(|v| v.as_str()).context("ciphertext")?;
        let nonce = enc.get("nonce").and_then(|v| v.as_str()).context("nonce")?;
        let eph = enc
            .get("ephemeral_public_key")
            .or_else(|| enc.get("ephemeralPublicKey"))
            .and_then(|v| v.as_str())
            .context("ephemeral key")?;

        let decrypted = decrypt_from_sender(ciphertext, nonce, eph, &wallet.box_secret_key)?;
        let task_data: Value = serde_json::from_str(&decrypted)?;
        let prompt = task_data
            .get("prompt")
            .and_then(|v| v.as_str())
            .context("prompt")?;
        let max_output = task_data
            .get("max_output_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(256) as i32;

        let (response, duration_ms, input_tokens, output_tokens) =
            ollama_generate(&config.ollama, model, prompt, max_output).await?;

        let result_hash = hash_str(&response);
        let mut result_payload = BTreeMap::new();
        result_payload.insert("task_id".into(), json!(task_id));
        result_payload.insert("result".into(), json!(response));
        result_payload.insert("result_hash".into(), json!(result_hash));
        result_payload.insert("duration_ms".into(), json!(duration_ms));
        result_payload.insert("input_tokens".into(), json!(input_tokens));
        result_payload.insert("output_tokens".into(), json!(output_tokens));

        let msg = make_ws_message(
            WsMessageType::TaskResult,
            &wallet.public_key,
            result_payload,
            wallet,
        );
        ws_tx.send(serde_json::to_string(&msg)?)?;

        let reward = payload
            .get("estimated_reward")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let mut s = stats.write().await;
        s.completed += 1;
        s.earned += reward;
        info!("Task {} completed in {}ms", task_id, duration_ms);
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(e) = result {
        stats.write().await.failed += 1;
        error!("Task {} failed: {}", task_id, e);
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();
    match cli.command {
        Commands::Start(args) => run(args).await,
    }
}

async fn run(config: StartArgs) -> Result<()> {
    let wallet = load_wallet(&config.wallet)?;
    let node_id = derive_node_id(&wallet.public_key);
    let stats = Arc::new(RwLock::new(NodeStats {
        uptime_start: now_ms(),
        ..Default::default()
    }));
    let active_tasks = Arc::new(RwLock::new(0i32));
    let enabled_models: Vec<String> = config
        .models
        .as_ref()
        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
        .unwrap_or_default();

    let active_ws: Arc<RwLock<Option<tokio::sync::mpsc::UnboundedSender<String>>>> =
        Arc::new(RwLock::new(None));

    // Coordinator WebSocket loop
    let ws_url = to_ws_url(&config.coordinator);
    let wallet_clone = wallet.clone();
    let config_clone = config.clone();
    let stats_clone = stats.clone();
    let active_clone = active_tasks.clone();
    let enabled_clone = enabled_models.clone();
    let node_id_ws = node_id.clone();
    let active_ws_conn = active_ws.clone();

    tokio::spawn(async move {
        loop {
            info!("Connecting to {}...", ws_url);
            let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            match connect_async(&ws_url).await {
                Ok((ws_stream, _)) => {
                    info!("Connected to coordinator");
                    *active_ws_conn.write().await = Some(out_tx.clone());
                    let (mut write, mut read) = ws_stream.split();

                    if let Err(e) = register_node(
                        &out_tx,
                        &wallet_clone,
                        &node_id_ws,
                        &config_clone,
                        &enabled_clone,
                    )
                    .await
                    {
                        error!("Registration failed: {}", e);
                    }

                    let write_task = tokio::spawn(async move {
                        while let Some(msg) = out_rx.recv().await {
                            if write.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                    });

                    while let Some(msg) = read.next().await {
                        let Ok(Message::Text(text)) = msg else {
                            break;
                        };
                        let Ok(parsed) = serde_json::from_str::<WsMessage>(&text) else {
                            continue;
                        };
                        match parsed.msg_type {
                            WsMessageType::Registered => {
                                info!("Registration confirmed: {:?}", parsed.payload);
                            }
                            WsMessageType::TaskPayload => {
                                let active = *active_clone.read().await;
                                if active >= config_clone.max_tasks {
                                    info!("At capacity, skipping task offer");
                                    continue;
                                }
                                *active_clone.write().await += 1;
                                let task_id = parsed
                                    .payload
                                    .get("task_id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let mut accept = BTreeMap::new();
                                accept.insert("task_id".into(), json!(task_id));
                                let accept_msg = make_ws_message(
                                    WsMessageType::TaskAccept,
                                    &wallet_clone.public_key,
                                    accept,
                                    &wallet_clone,
                                );
                                let _ = out_tx.send(serde_json::to_string(&accept_msg).unwrap());

                                let payload = parsed.payload.clone();
                                let tx = out_tx.clone();
                                let w = wallet_clone.clone();
                                let cfg = config_clone.clone();
                                let st = stats_clone.clone();
                                let act = active_clone.clone();
                                tokio::spawn(async move {
                                    process_task(&tx, &w, &cfg, &payload, &st).await;
                                    *act.write().await -= 1;
                                });
                            }
                            WsMessageType::RewardConfirmed => {
                                let amount = parsed.payload.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
                                stats_clone.write().await.earned += amount;
                            }
                            _ => {}
                        }
                    }
                    write_task.abort();
                    *active_ws_conn.write().await = None;
                }
                Err(e) => error!("WebSocket error: {}", e),
            }
            warn!("Disconnected. Reconnecting in 5s...");
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    // Optional P2P gossip
    if !config.p2p_bootstrap.is_empty() || config.p2p_port > 0 {
        let public_host = std::env::var("NOETIS_PUBLIC_HOST")
            .or_else(|_| std::env::var("PUBLIC_HOST"))
            .ok();
        let gossip = GossipNetwork::new(
            node_id.clone(),
            wallet.clone(),
            config.p2p_port,
            public_host,
        );
        let bootstraps = if config.p2p_bootstrap.is_empty() {
            vec![]
        } else {
            vec![config.p2p_bootstrap.clone()]
        };
        if gossip.start(bootstraps).await.is_ok() {
            info!("P2P gossip active on port {}", config.p2p_port);
            let models = ollama_list_models(&config.ollama).await;
            let _ = gossip
                .gossip(
                    P2pMessageType::NodeAnnounce,
                    [
                        ("node_id".into(), json!(node_id)),
                        ("wallet_address".into(), json!(wallet.address)),
                        ("public_key".into(), json!(wallet.public_key)),
                        ("box_public_key".into(), json!(wallet.box_public_key)),
                        ("models".into(), json!(models)),
                        ("status".into(), json!("available")),
                    ]
                    .into_iter()
                    .collect(),
                    3,
                )
                .await;
        }
    }

    // Heartbeat loop
    let hb_wallet = wallet.clone();
    let hb_ws = active_ws.clone();
    let hb_stats = stats.clone();
    let hb_active = active_tasks.clone();
    let hb_max = config.max_tasks;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            let active = *hb_active.read().await;
            let s = hb_stats.read().await;
            let mut payload = BTreeMap::new();
            payload.insert(
                "status".into(),
                json!(if active >= hb_max { "busy" } else { "available" }),
            );
            payload.insert("active_tasks".into(), json!(active));
            payload.insert("completed".into(), json!(s.completed));
            payload.insert("failed".into(), json!(s.failed));
            payload.insert("earned".into(), json!(s.earned));
            payload.insert(
                "uptime_seconds".into(),
                json!((now_ms() - s.uptime_start) / 1000),
            );
            drop(s);
            let msg = make_ws_message(
                WsMessageType::NodeHeartbeat,
                &hb_wallet.public_key,
                payload,
                &hb_wallet,
            );
            if let Some(tx) = hb_ws.read().await.clone() {
                let _ = tx.send(serde_json::to_string(&msg).unwrap());
            }
        }
    });

    info!("Node stake requirement (prototype): {} NOET", NODE_STAKE_AMOUNT);
    info!("Wallet: {}", wallet.address);

    // Keep running
    tokio::signal::ctrl_c().await?;
    Ok(())
}
