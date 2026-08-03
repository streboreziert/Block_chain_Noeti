//! Noetis hub — Rust implementation of the Python `app.py` hub.
//! Same HTTP API, same chain format: Python and Rust nodes interoperate.

use axum::extract::{Path as AxPath, Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;
use noetis_chain::chain::{Chain, TrustMode};
use noetis_chain::spv::{account_proof, verify_account_proof};
use noetis_chain::state::{get_balance, has_minimum_stake, MIN_STAKE, VALIDATOR_MIN_STAKE};
use noetis_chain::validators::Validators;
use noetis_network::client_static::{asset_response, download_page_html, render_app_html};
use noetis_network::gossip::GossipMesh;
use noetis_network::hubstate::Hub;
use noetis_network::ratelimit::check_rate_limit;
use noetis_network::{consensus_net, data_dir, lan_ip};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tower_http::cors::{Any, CorsLayer};

type Shared = Arc<Mutex<Hub>>;

#[derive(Parser)]
#[command(name = "noetis-hub", about = "Noetis network hub (Rust)")]
struct Args {
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
    #[arg(long, default_value_t = 5052)]
    port: u16,
    #[arg(long, default_value_t = 5053)]
    mesh_port: u16,
    #[arg(long, default_value = "")]
    public_url: String,
    #[arg(long, default_value = "qwen2.5:0.5b")]
    model: String,
}

fn err(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or("").trim().to_string())
        .unwrap_or_else(|| "unknown".into())
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let data = data_dir();
    std::fs::create_dir_all(&data).ok();

    let quorum_env: usize = std::env::var("COSIGN_QUORUM").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut validators = Validators::open(&data, quorum_env);
    let public_url = if args.public_url.is_empty() {
        format!("http://{}:{}", lan_ip(), args.port)
    } else {
        args.public_url.trim_end_matches('/').to_string()
    };
    validators.set_hub_url(&public_url);

    let mut chain = Chain::new(&data);
    let boot_state = chain.current_state();
    let trust = TrustMode::Registry {
        known: validators.known_validators(&boot_state),
        quorum: 1,
    };
    if let Err(error) = chain.load(&trust) {
        eprintln!("FATAL: {error}");
        std::process::exit(1);
    }

    let mesh = GossipMesh::new(args.mesh_port);
    let hub = Arc::new(Mutex::new(Hub {
        hub_id: "hub-01".into(),
        role: std::env::var("HUB_ROLE").unwrap_or_else(|_| "hub".into()),
        model: args.model.clone(),
        public_url: public_url.clone(),
        chain,
        validators,
        mesh: mesh.clone(),
        compute: HashMap::new(),
        relays: HashMap::new(),
        tasks: HashMap::new(),
        wallet_by_worker: HashMap::new(),
        events: vec![],
        stats: vec![],
        mempool: vec![],
        running_task: None,
        last_error: None,
    }));

    // Gossip: adopt announced blocks that extend our chain.
    {
        let hub_for_gossip = hub.clone();
        mesh.set_block_handler(Arc::new(move |block: Value| {
            let mut guard = hub_for_gossip.lock().unwrap();
            let extends = block.get("index").and_then(Value::as_i64) == Some(guard.chain.len() as i64)
                && block.get("previous_hash").and_then(Value::as_str)
                    == Some(guard.chain.last_block().hash.as_str());
            if extends {
                let mut payload = guard.chain.to_dicts();
                payload.push(block);
                let trust = guard.trust_mode();
                let pubkeys = guard.sorted_validator_pubkeys();
                let _ = guard.chain.merge_chain(&payload, &trust, &pubkeys);
            }
        }));
    }

    // Federation bootstrap: register with peers, import their identities, unify chains.
    {
        let mut guard = hub.lock().unwrap();
        for peer in consensus_net::federation_peers_env() {
            if peer == public_url {
                continue;
            }
            let _ = consensus_net::register_self_with_peer(&peer, &public_url, &guard.validators);
            let _ = consensus_net::import_peer_validator(&peer, &guard.validators);
            if let Ok(remote_blocks) = consensus_net::fetch_remote_blocks(&peer) {
                let trust = guard.trust_mode();
                let pubkeys = guard.sorted_validator_pubkeys();
                let _ = guard.chain.merge_chain(&remote_blocks, &trust, &pubkeys);
            }
            if let Some(mesh_peer) = noetis_network::gossip::resolve_mesh_peer(&peer, args.mesh_port) {
                mesh.add_peer(&mesh_peer);
            }
        }
        guard.log("network", "Hub online (Rust)");
    }

    let app = Router::new()
        .route("/", get(landing))
        .route("/app", get(serve_app))
        .route("/mobile", get(serve_app))
        .route("/mobile/", get(serve_app))
        .route("/download", get(serve_download))
        .route("/download/", get(serve_download))
        .route("/install.sh", get(serve_install_sh))
        .route("/install.ps1", get(serve_install_ps1))
        .route("/join.sh", get(serve_join_sh))
        .route("/manifest.json", get(|| async { asset_response("manifest.json") }))
        .route("/sw.js", get(|| async { asset_response("sw.js") }))
        .route(
            "/static/{*path}",
            get(|AxPath(path): AxPath<String>| async move {
                asset_response(&format!("static/{path}"))
            }),
        )
        .route("/entry.txt", get(entry_txt))
        .route("/network.txt", get(entry_txt))
        .route("/api/health", get(health))
        .route("/api/onboard", get(onboard))
        .route("/api/validator", get(validator_get))
        .route("/api/validator/register", post(validator_register))
        .route("/api/validators", get(validators_list))
        .route("/api/discovery", get(discovery))
        .route("/api/entry", get(entry_info))
        .route("/api/status", get(status))
        .route("/api/network-status", get(status))
        .route("/api/chain", get(chain_snapshot))
        .route("/api/chain/full", get(chain_full))
        .route("/api/chain/headers", get(chain_headers))
        .route("/api/chain/block/{index}", get(chain_block))
        .route("/api/chain/cosign", post(chain_cosign))
        .route("/api/chain/sync", post(chain_sync))
        .route("/api/chain/finalize-pending", post(finalize_pending))
        .route("/api/mesh", get(mesh_status))
        .route("/api/transfer", post(transfer))
        .route("/api/wallet/proof", get(wallet_proof))
        .route("/api/wallet/balance", get(wallet_balance))
        .route("/api/wallet/nonce", get(wallet_nonce))
        .route("/api/staking/status", get(staking_status))
        .route("/api/faucet", post(faucet))
        .route("/api/mempool", get(mempool))
        .route("/api/transactions", get(transactions))
        .route("/api/wallets", get(wallets))
        .route("/api/relay/register", post(relay_register))
        .route("/api/relay/heartbeat", post(relay_heartbeat))
        .route("/api/relay/poll", get(relay_poll))
        .route("/api/relay/forward", post(relay_forward))
        .route("/api/compute/register", post(compute_register))
        .route("/api/compute/heartbeat", post(compute_heartbeat))
        .route("/api/compute/unregister", post(compute_unregister))
        .route("/api/compute/leave", post(compute_unregister))
        .route("/api/compute/poll", get(compute_poll))
        .route("/api/compute/offers", get(compute_offers))
        .route("/api/compute/claim", post(compute_claim))
        .route("/api/compute/result", post(compute_result))
        .route("/api/infer", post(infer))
        .route("/api/prompt", post(infer))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers(Any),
        )
        .with_state(hub.clone());

    println!();
    println!("  Noetis Network Hub (Rust)");
    println!("  API:   http://127.0.0.1:{}", args.port);
    println!("  App:   http://127.0.0.1:{}/app", args.port);
    println!("  Mesh:  port {}", args.mesh_port);
    println!("  Public: {public_url}");
    println!();

    let listener = tokio::net::TcpListener::bind((args.host.as_str(), args.port))
        .await
        .expect("bind hub port");
    axum::serve(listener, app).await.expect("serve");
}

// ---- basic pages ---------------------------------------------------------

async fn serve_app() -> Response {
    render_app_html("").into_response()
}

async fn serve_download() -> Response {
    download_page_html("https://noeticompute.com/downloads").into_response()
}

async fn serve_install_sh() -> Response {
    (
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        include_str!("../../../../scripts/install-user.sh"),
    )
        .into_response()
}

async fn serve_install_ps1() -> Response {
    (
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        include_str!("../../../../scripts/install-user.ps1"),
    )
        .into_response()
}

async fn serve_join_sh() -> Response {
    (
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        include_str!("../../../../scripts/join-rust.sh"),
    )
        .into_response()
}

async fn landing(State(hub): State<Shared>) -> Response {
    let mut guard = hub.lock().unwrap();
    let length = guard.chain.len();
    let trust = guard.trust_mode();
    let valid = guard.chain.is_valid_structure(&trust, true) && guard.chain.is_valid_state();
    let text = format!(
        "Noetis Network Hub (Rust)\n\n\
         chain_length={length}\n\
         chain_valid={valid}\n\n\
         User app:  /app   (or /mobile for Android PWA)\n\
         Downloads: /download\n\
         Install:   /install.sh  /install.ps1\n\
         Discovery: /entry.txt\n\
         API:       /api/health /api/chain /api/discovery\n"
    );
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        text,
    )
        .into_response()
}

async fn entry_txt(State(hub): State<Shared>) -> Response {
    let payload = discovery_payload(&hub);
    let mut lines = vec![
        "# Noetis network entry — auto-updated (Rust hub)".to_string(),
        format!("network_name={}", payload.get("network_name").and_then(Value::as_str).unwrap_or("Noetis")),
        format!("public_url={}", payload.get("public_url").and_then(Value::as_str).unwrap_or("")),
        format!("lan_ip={}", payload.get("lan_ip").and_then(Value::as_str).unwrap_or("")),
        format!("api_port={}", payload.get("api_port").and_then(Value::as_i64).unwrap_or(5052)),
        format!("mesh_port={}", payload.get("mesh_port").and_then(Value::as_i64).unwrap_or(5053)),
        format!("chain_version={}", payload.get("chain_version").and_then(Value::as_i64).unwrap_or(4)),
        format!("chain_length={}", payload.get("chain_length").and_then(Value::as_i64).unwrap_or(0)),
        format!("compute_online={}", payload.get("compute_online").and_then(Value::as_i64).unwrap_or(0)),
        format!("relay_online={}", payload.get("relay_online").and_then(Value::as_i64).unwrap_or(0)),
        String::new(),
        "# validators (public keys)".to_string(),
    ];
    for (index, validator) in payload
        .get("validators")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        lines.push(format!("[validator_{}]", index + 1));
        lines.push(format!("hub_url={}", validator.get("hub_url").and_then(Value::as_str).unwrap_or("")));
        lines.push(format!("validator_id={}", validator.get("validator_id").and_then(Value::as_str).unwrap_or("")));
        lines.push(format!("address={}", validator.get("address").and_then(Value::as_str).unwrap_or("")));
        lines.push(format!("public_key={}", validator.get("public_key").and_then(Value::as_str).unwrap_or("")));
        lines.push(String::new());
    }
    ([("content-type", "text/plain; charset=utf-8")], lines.join("\n")).into_response()
}

fn discovery_payload(hub: &Shared) -> Value {
    let mut guard = hub.lock().unwrap();
    let state = guard.chain.current_state();
    let validators: Vec<Value> = guard
        .validators
        .known_validators(&state)
        .values()
        .map(|v| v.to_dict())
        .collect();
    let local = guard.validators.info();
    let mesh_snapshot = guard.mesh.snapshot();
    let (nodes, relays) = guard.nodes_snapshot();
    let devices: Vec<Value> = nodes
        .iter()
        .map(|n| {
            let mut m = n.as_object().cloned().unwrap_or_default();
            m.insert("device_type".into(), json!("compute"));
            Value::Object(m)
        })
        .chain(relays.iter().map(|r| {
            let mut m = r.as_object().cloned().unwrap_or_default();
            m.insert("device_type".into(), json!("relay"));
            Value::Object(m)
        }))
        .collect();
    json!({
        "network_name": "Noetis Mainnet",
        "public_url": guard.public_url,
        "lan_ip": lan_ip(),
        "api_port": 5052,
        "mesh_port": mesh_snapshot.get("mesh_port"),
        "chain_version": noetis_chain::block::CHAIN_VERSION,
        "chain_length": guard.chain.len(),
        "validator": local.to_dict(),
        "validators": validators,
        "devices": devices,
        "compute_online": guard.online_compute_count(),
        "relay_online": guard.online_relay_count(),
        "mesh_peers": mesh_snapshot.get("peers"),
        "flow": "user → entry point → relay → compute",
    })
}

// ---- API handlers ----------------------------------------------------------

async fn health(State(hub): State<Shared>) -> Json<Value> {
    let mut guard = hub.lock().unwrap();
    let trust = guard.trust_mode();
    let valid = guard.chain.is_valid_structure(&trust, true) && guard.chain.is_valid_state();
    Json(json!({
        "ok": true,
        "service": "noetis-network",
        "implementation": "rust",
        "chain_length": guard.chain.len(),
        "chain_valid": valid,
        "chain_version": noetis_chain::block::CHAIN_VERSION,
    }))
}

async fn onboard(State(hub): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Json<Value> {
    let guard = hub.lock().unwrap();
    let address = params.get("address").map(String::as_str).unwrap_or("").trim().to_string();
    let (eligible, message) = if address.is_empty() {
        (false, "Pass ?address= to check faucet eligibility".to_string())
    } else {
        guard.can_claim_faucet(&address)
    };
    Json(json!({
        "faucet_enabled": guard.faucet_allowed(),
        "faucet_mode": guard.faucet_mode(),
        "hub_blind": noetis_network::hubstate::hub_blind(),
        "min_stake": MIN_STAKE,
        "eligible": if address.is_empty() { Value::Null } else { json!(eligible) },
        "message": message,
        "steps": [
            "Create wallet: noetis-wallet create",
            "Request onboarding MLC via faucet",
            "Stake 10 MLC: noetis-wallet stake --node-id my-gpu",
            "Join compute: noetis-compute --id my-gpu",
        ],
    }))
}

async fn validator_get(State(hub): State<Shared>) -> Json<Value> {
    let mut guard = hub.lock().unwrap();
    let state = guard.chain.current_state();
    let count = guard.validators.known_validators(&state).len();
    let mut info = guard.validators.info().to_dict();
    info["federation_count"] = json!(count);
    Json(info)
}

async fn validator_register(State(hub): State<Shared>, Json(payload): Json<Value>) -> Response {
    let guard = hub.lock().unwrap();
    let result = guard.validators.register_peer(
        payload.get("hub_url").and_then(Value::as_str).unwrap_or("").trim(),
        payload.get("validator_id").and_then(Value::as_str).unwrap_or("").trim(),
        payload.get("public_key").and_then(Value::as_str).unwrap_or("").trim(),
        payload.get("address").and_then(Value::as_str).unwrap_or("").trim(),
        payload.get("signature").and_then(Value::as_str).unwrap_or("").trim(),
        payload.get("timestamp").and_then(Value::as_f64).unwrap_or_else(noetis_chain::now),
    );
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn validators_list(State(hub): State<Shared>) -> Json<Value> {
    let mut guard = hub.lock().unwrap();
    let state = guard.chain.current_state();
    let known: Vec<Value> = guard.validators.known_validators(&state).values().map(|v| v.to_dict()).collect();
    let on_chain = noetis_chain::state::on_chain_validators(&state);
    let pubkeys = guard.sorted_validator_pubkeys();
    let next_height = guard.chain.len() as i64;
    let schedule: Vec<Value> = (next_height..next_height + 5)
        .map(|height| {
            json!({
                "height": height,
                "proposer_pubkey": noetis_chain::schedule::proposer_pubkey_for_height(height, &pubkeys),
            })
        })
        .collect();
    Json(json!({
        "validators": known,
        "on_chain": on_chain,
        "validator_min_stake": VALIDATOR_MIN_STAKE,
        "proposer_schedule": schedule,
    }))
}

async fn discovery(State(hub): State<Shared>) -> Json<Value> {
    Json(discovery_payload(&hub))
}

async fn entry_info(State(hub): State<Shared>) -> Json<Value> {
    let guard = hub.lock().unwrap();
    Json(json!({
        "network_name": "Noetis Mainnet",
        "entry_url": guard.public_url,
        "hub_url": guard.public_url,
        "join_url": guard.public_url,
        "flow": "user → entry point → relay → compute",
    }))
}

async fn status(State(hub): State<Shared>) -> Json<Value> {
    let mut guard = hub.lock().unwrap();
    guard.expire_stale_tasks();
    let (nodes, relays) = guard.nodes_snapshot();
    let (ollama_count, browser_count) = guard.runtime_counts();
    let trust = guard.trust_mode();
    let chain_snap = guard.chain.snapshot(&trust, false);
    let quorum = guard.effective_quorum();
    let state = guard.chain.current_state();
    let federation = guard.validators.known_validators(&state).len();
    let supply: f64 = guard
        .balances_rows()
        .iter()
        .filter_map(|row| row.get("balance").and_then(Value::as_f64))
        .sum();
    Json(json!({
        "mode": "network_hub",
        "role": guard.role,
        "hub_id": guard.hub_id,
        "implementation": "rust",
        "privacy": "user → relay → compute (compute never sees user identity)",
        "compute_count": nodes.len(),
        "ollama_count": ollama_count,
        "browser_count": browser_count,
        "relay_count": relays.len(),
        "node_count": nodes.len(),
        "worker_count": nodes.len(),
        "nodes": nodes,
        "relays": relays,
        "events": guard.events.iter().rev().take(100).rev().cloned().collect::<Vec<_>>(),
        "running_task": guard.running_task,
        "dispatch_error": guard.last_error,
        "last_task": guard.stats.last().cloned().unwrap_or(Value::Null),
        "task_count": guard.stats.len(),
        "faucet_enabled": guard.faucet_allowed(),
        "faucet_mode": guard.faucet_mode(),
        "hub_blind": noetis_network::hubstate::hub_blind(),
        "mesh_consensus": noetis_network::hubstate::mesh_consensus(),
        "decentralization": {
            "validators": federation,
            "cosign_quorum": quorum,
            "mesh_consensus": noetis_network::hubstate::mesh_consensus(),
            "hub_blind": noetis_network::hubstate::hub_blind(),
            "faucet": if guard.faucet_allowed() { guard.faucet_mode() } else { "off".into() },
        },
        "blockchain": chain_snap,
        "mesh": guard.mesh.snapshot(),
        "federation_peers": federation,
        "consensus_quorum": quorum,
        "mlc_supply_distributed": noetis_chain::pyjson::round4(supply),
        "join_url": "/api/compute/register",
        "architecture": {
            "layers": [
                {"name": "User", "role": "Submits prompts — never connects to compute directly"},
                {"name": "Relay", "role": "Third-party routing layer — strips user identity"},
                {"name": "Hub", "role": "Coordinator — consensus and blockchain settlement"},
                {"name": "Compute", "role": "Runs anonymous inference tasks via Ollama"},
                {"name": "Blockchain", "role": "Proof-of-Inference settlement"},
                {"name": "MLC", "role": "Rewards for verified compute"},
            ],
            "consensus": "Majority vote on inference outputs",
            "proof_type": "proof_of_inference",
            "token": "MLC",
        },
    }))
}

async fn chain_snapshot(State(hub): State<Shared>) -> Json<Value> {
    let mut guard = hub.lock().unwrap();
    let trust = guard.trust_mode();
    Json(guard.chain.snapshot(&trust, false))
}

async fn chain_full(State(hub): State<Shared>) -> Json<Value> {
    let mut guard = hub.lock().unwrap();
    let trust = guard.trust_mode();
    Json(guard.chain.snapshot(&trust, true))
}

async fn chain_headers(State(hub): State<Shared>) -> Json<Value> {
    let mut guard = hub.lock().unwrap();
    let trust = guard.trust_mode();
    Json(guard.chain.headers_snapshot(&trust))
}

async fn chain_block(State(hub): State<Shared>, AxPath(index): AxPath<i64>) -> Response {
    let guard = hub.lock().unwrap();
    match guard.chain.get_block(index) {
        Some(block) => Json(block).into_response(),
        None => err(StatusCode::NOT_FOUND, "Block not found"),
    }
}

async fn chain_cosign(State(hub): State<Shared>, Json(payload): Json<Value>) -> Response {
    let Some(block) = payload.get("block").filter(|b| b.is_object()).cloned() else {
        return err(StatusCode::BAD_REQUEST, "block required");
    };
    let mut guard = hub.lock().unwrap();
    if block.get("index").and_then(Value::as_i64) != Some(guard.chain.len() as i64) {
        return err(StatusCode::BAD_REQUEST, "Block index does not extend local chain");
    }
    if block.get("previous_hash").and_then(Value::as_str) != Some(guard.chain.last_block().hash.as_str()) {
        return err(StatusCode::BAD_REQUEST, "Block previous_hash mismatch");
    }
    let mut extended = guard.chain.to_dicts();
    extended.push(block.clone());
    let trust = guard.trust_mode();
    let candidate = Chain::from_payload(&guard.validators.data_dir, &extended);
    let valid = candidate
        .map(|blocks| {
            let probe = Chain::probe(&guard.validators.data_dir, blocks);
            probe.is_valid_structure(&trust, false) && probe.is_valid_state()
        })
        .unwrap_or(false);
    if !valid {
        return err(StatusCode::BAD_REQUEST, "Invalid block — rejected");
    }
    let proof = block.get("proof").cloned().unwrap_or(Value::Null);
    let block_hash = block.get("hash").and_then(Value::as_str).unwrap_or("");
    let cosign = guard.validators.make_cosignature(&proof, block_hash);
    guard.log("consensus", &format!("Cosigned block #{}", block.get("index").and_then(Value::as_i64).unwrap_or(0)));
    Json(json!({"ok": true, "cosignature": cosign})).into_response()
}

async fn chain_sync(State(hub): State<Shared>, headers: HeaderMap, Json(payload): Json<Value>) -> Response {
    let ip = client_ip(&headers);
    if let Err(reason) = check_rate_limit(&format!("sync:{ip}"), 6, 60.0) {
        return err(StatusCode::TOO_MANY_REQUESTS, &reason);
    }
    let Some(blocks) = payload.get("blocks").and_then(Value::as_array).cloned() else {
        return err(StatusCode::BAD_REQUEST, "blocks array required");
    };
    let mut guard = hub.lock().unwrap();
    let trust = guard.trust_mode();
    let pubkeys = guard.sorted_validator_pubkeys();
    let result = guard.chain.merge_chain(&blocks, &trust, &pubkeys);
    if result.get("action").and_then(Value::as_str) == Some("merged") {
        let length = guard.chain.len();
        guard.log("sync", &format!("P2P chain merged — length {length}"));
    }
    Json(result).into_response()
}

async fn finalize_pending(State(hub): State<Shared>) -> Response {
    let mut guard = hub.lock().unwrap();
    let txs: Vec<Value> = guard.mempool.drain(..).collect();
    if txs.is_empty() {
        let index = guard.chain.last_block().index;
        return Json(json!({"ok": true, "block_index": index, "pending": 0})).into_response();
    }
    let count = txs.len();
    match guard.commit_state_block(txs, "Pending signed transactions") {
        Ok(index) => Json(json!({"ok": true, "block_index": index, "transactions": count})).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn transfer(State(hub): State<Shared>, Json(payload): Json<Value>) -> Response {
    let mut guard = hub.lock().unwrap();
    match guard.add_signed_tx_block(payload) {
        Ok(result) => Json(result).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn wallet_proof(State(hub): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let address = params.get("address").map(String::as_str).unwrap_or("").trim().to_string();
    if address.is_empty() {
        return err(StatusCode::BAD_REQUEST, "address required");
    }
    let mut guard = hub.lock().unwrap();
    let state = guard.chain.current_state();
    match account_proof(&state, &address) {
        Some(mut proof) => {
            let verified = verify_account_proof(&proof);
            proof["verified"] = json!(verified);
            Json(proof).into_response()
        }
        None => err(StatusCode::NOT_FOUND, "Account not found"),
    }
}

async fn wallet_balance(State(hub): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let address = params.get("address").map(String::as_str).unwrap_or("").trim().to_string();
    if address.is_empty() {
        return err(StatusCode::BAD_REQUEST, "address required");
    }
    let mut guard = hub.lock().unwrap();
    let state = guard.chain.current_state();
    Json(get_balance(&state, &address)).into_response()
}

async fn wallet_nonce(State(hub): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let address = params.get("address").map(String::as_str).unwrap_or("").trim().to_string();
    if address.is_empty() {
        return err(StatusCode::BAD_REQUEST, "address required");
    }
    let mut guard = hub.lock().unwrap();
    let state = guard.chain.current_state();
    let nonce = state.get(&address).map(|row| row.nonce).unwrap_or(0);
    Json(json!({"address": address, "nonce": nonce})).into_response()
}

async fn staking_status(State(hub): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let address = params.get("address").map(String::as_str).unwrap_or("").trim().to_string();
    let node_id = params.get("node_id").map(String::as_str).unwrap_or("").trim().to_string();
    if address.is_empty() || node_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "address and node_id required");
    }
    let mut guard = hub.lock().unwrap();
    let state = guard.chain.current_state();
    let staked = state.get(&address).map(|row| row.staked).unwrap_or(0.0);
    let eligible = has_minimum_stake(&state, &address, &node_id);
    Json(json!({
        "address": address,
        "node_id": node_id,
        "min_stake": MIN_STAKE,
        "staked": staked,
        "eligible": eligible,
        "message": if eligible {
            "Stake locked — eligible for compute tasks".to_string()
        } else {
            format!("Stake at least {MIN_STAKE} MLC for node {node_id}")
        },
    }))
    .into_response()
}

async fn faucet(State(hub): State<Shared>, headers: HeaderMap, Json(payload): Json<Value>) -> Response {
    let ip = client_ip(&headers);
    if let Err(reason) = check_rate_limit(&format!("faucet:{ip}"), 5, 86_400.0) {
        return err(StatusCode::TOO_MANY_REQUESTS, &reason);
    }
    let address = payload.get("address").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if address.is_empty() {
        return err(StatusCode::BAD_REQUEST, "address required");
    }
    let amount = payload.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
    let mut guard = hub.lock().unwrap();
    match guard.grant_faucet(&address, if amount > 0.0 { amount } else { 50.0 }) {
        Ok(result) => Json(result).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn mempool(State(hub): State<Shared>) -> Json<Value> {
    let guard = hub.lock().unwrap();
    Json(json!({"transactions": guard.mempool}))
}

async fn transactions(State(hub): State<Shared>) -> Json<Value> {
    let guard = hub.lock().unwrap();
    let mut entries = guard.ledger(50);
    for entry in &mut entries {
        let time = entry.get("time").and_then(Value::as_f64).unwrap_or(0.0);
        use chrono::TimeZone;
        let time_str = match chrono::Local.timestamp_opt(time as i64, 0) {
            chrono::LocalResult::Single(dt) => dt.format("%H:%M:%S").to_string(),
            _ => String::new(),
        };
        entry["time_str"] = json!(time_str);
    }
    Json(json!({"transactions": entries, "token": "MLC"}))
}

async fn wallets(State(hub): State<Shared>) -> Json<Value> {
    let mut guard = hub.lock().unwrap();
    let rows = guard.balances_rows();
    Json(json!({"token": "MLC", "wallets": rows, "count": rows.len()}))
}

async fn mesh_status(State(hub): State<Shared>) -> Json<Value> {
    let guard = hub.lock().unwrap();
    Json(guard.mesh.snapshot())
}

// ---- relay + compute -------------------------------------------------------

async fn relay_register(State(hub): State<Shared>, headers: HeaderMap, Json(payload): Json<Value>) -> Response {
    let relay_id = payload.get("relay_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if relay_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "relay_id required");
    }
    let access_url = payload.get("access_url").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let ip = client_ip(&headers);
    let mut guard = hub.lock().unwrap();
    match guard.register_relay(&relay_id, &ip, &access_url) {
        Ok(result) => Json(result).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn relay_heartbeat(State(hub): State<Shared>, Json(payload): Json<Value>) -> Response {
    let relay_id = payload.get("relay_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if relay_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "relay_id required");
    }
    let mut guard = hub.lock().unwrap();
    match guard.relay_heartbeat(&relay_id) {
        Ok(result) => Json(result).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn relay_poll(State(hub): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let relay_id = params.get("relay_id").map(String::as_str).unwrap_or("").trim().to_string();
    if relay_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "relay_id required");
    }
    let mut guard = hub.lock().unwrap();
    match guard.poll_relay_task(&relay_id) {
        Ok(task) => Json(task.unwrap_or_else(|| json!({}))).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn relay_forward(State(hub): State<Shared>, Json(payload): Json<Value>) -> Response {
    let relay_id = payload.get("relay_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let task_id = payload.get("task_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if relay_id.is_empty() || task_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "relay_id and task_id required");
    }
    let mut guard = hub.lock().unwrap();
    match guard.forward_relay_task(&relay_id, &task_id) {
        Ok(result) => Json(result).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn compute_register(State(hub): State<Shared>, headers: HeaderMap, Json(payload): Json<Value>) -> Response {
    let node_id = payload.get("node_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if node_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "node_id required");
    }
    let model = payload.get("model").and_then(Value::as_str).unwrap_or("qwen2.5:0.5b").to_string();
    let wallet_address = payload.get("wallet_address").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let enc_pubkey = payload.get("enc_pubkey").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let access_url = payload.get("access_url").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let runtime = payload.get("runtime").and_then(Value::as_str).unwrap_or("ollama").to_string();
    let ip = client_ip(&headers);
    let mut guard = hub.lock().unwrap();
    let public = guard.public_url.clone();
    match guard.register_compute(&node_id, &model, &wallet_address, &enc_pubkey, &ip, &access_url, &runtime) {
        Ok(mut result) => {
            result["hub_url"] = json!(public);
            Json(result).into_response()
        }
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn compute_heartbeat(State(hub): State<Shared>, Json(payload): Json<Value>) -> Response {
    let node_id = payload.get("node_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if node_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "node_id required");
    }
    let mut guard = hub.lock().unwrap();
    match guard.compute_heartbeat(&node_id) {
        Ok(result) => Json(result).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn compute_unregister(State(hub): State<Shared>, Json(payload): Json<Value>) -> Response {
    let node_id = payload.get("node_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if node_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "node_id required");
    }
    let mut guard = hub.lock().unwrap();
    match guard.unregister_compute(&node_id) {
        Ok(result) => Json(result).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn compute_poll(State(hub): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let node_id = params.get("node_id").map(String::as_str).unwrap_or("").trim().to_string();
    if node_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "node_id required");
    }
    let mut guard = hub.lock().unwrap();
    match guard.poll_compute_task(&node_id) {
        Ok(task) => Json(task.unwrap_or_else(|| json!({}))).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn compute_offers(State(hub): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let node_id = params.get("node_id").map(String::as_str).unwrap_or("").trim().to_string();
    if node_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "node_id required");
    }
    let mut guard = hub.lock().unwrap();
    match guard.list_open_offers(&node_id) {
        Ok(offers) => {
            let count = offers.len();
            Json(json!({"offers": offers, "count": count})).into_response()
        }
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn compute_claim(State(hub): State<Shared>, Json(payload): Json<Value>) -> Response {
    let node_id = payload
        .get("node_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let task_id = payload
        .get("task_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if node_id.is_empty() || task_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "node_id and task_id required");
    }
    let mut guard = hub.lock().unwrap();
    match guard.claim_compute_task(&node_id, &task_id) {
        Ok(task) => Json(task).into_response(),
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

async fn compute_result(State(hub): State<Shared>, Json(payload): Json<Value>) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        let mut guard = hub.lock().unwrap();
        guard.submit_result(
            payload.get("task_id").and_then(Value::as_str).unwrap_or(""),
            payload.get("node_id").and_then(Value::as_str).unwrap_or(""),
            payload.get("response").and_then(Value::as_str).unwrap_or("").to_string(),
            payload.get("inference_ms").and_then(Value::as_f64).unwrap_or(0.0),
            payload.get("model").and_then(Value::as_str).unwrap_or(""),
            payload.get("attestation").filter(|a| a.is_object()),
            payload.get("response_encrypted").and_then(Value::as_bool).unwrap_or(false),
            payload.get("response_ciphertext").and_then(Value::as_str).unwrap_or(""),
            payload.get("response_nonce").and_then(Value::as_str).unwrap_or(""),
        )
    })
    .await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => err(StatusCode::BAD_REQUEST, &error),
        Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    }
}

async fn infer(State(hub): State<Shared>, headers: HeaderMap, Json(payload): Json<Value>) -> Response {
    let ip = client_ip(&headers);
    if let Err(reason) = check_rate_limit(&format!("infer:{ip}"), 12, 60.0) {
        return err(StatusCode::TOO_MANY_REQUESTS, &reason);
    }
    let prompt = payload
        .get("text")
        .or_else(|| payload.get("prompt"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if prompt.is_empty() {
        return err(StatusCode::BAD_REQUEST, "text required");
    }

    let (task_result, online, model) = {
        let mut guard = hub.lock().unwrap();
        let online = guard.online_compute_count();
        let model = guard.model.clone();
        (guard.start_task(&prompt), online, model)
    };
    let task_id = match task_result {
        Ok(id) => id,
        Err(error) => return err(StatusCode::BAD_REQUEST, &error),
    };

    // No external compute online → local Ollama fallback (3 simulated nodes),
    // exactly like the Python hub.
    if online == 0 {
        let hub_bg = hub.clone();
        std::thread::spawn(move || {
            let mut client = noetis_network::ollama::OllamaClient::new(&model);
            if client.resolve_model(&[&model, "qwen2.5:0.5b", "llama3.2:1b", "phi3:mini"]).is_err() {
                let mut guard = hub_bg.lock().unwrap();
                guard.last_error = Some("No compute online. Join as compute, or install Ollama.".into());
                guard.running_task = None;
                return;
            }
            for index in 1..=3 {
                let node_id = format!("local-{index:02}");
                match client.generate(&prompt) {
                    Ok(output) => {
                        let mut guard = hub_bg.lock().unwrap();
                        if let Some(task) = guard.tasks.get_mut(&task_id) {
                            let response_hash = noetis_chain::pyjson::sha256_text(&output.response);
                            task.results.push(noetis_network::hubstate::TaskResultRow {
                                worker_id: node_id,
                                response: output.response,
                                response_hash,
                                inference_ms: output.inference_ms,
                                model: output.model,
                                matched_consensus: false,
                                reward: 0.0,
                            });
                        }
                    }
                    Err(error) => {
                        let mut guard = hub_bg.lock().unwrap();
                        guard.last_error = Some(error);
                    }
                }
            }
            let mut guard = hub_bg.lock().unwrap();
            let _ = guard.finalize_task(&task_id);
            guard.running_task = None;
        });
    }
    Json(json!({"ok": true, "started": true})).into_response()
}
