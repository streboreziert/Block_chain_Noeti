use anyhow::{Context, Result};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use clap::{Parser, Subcommand};
use noetis_blockchain::{
    apply_block, attest_block, create_blockchain, create_tx, derive_state_from_chain,
    get_block_height, get_latest_block, get_proposer, propose_block, validate_block_signatures,
    validate_chain, AttestedBlock, BlockchainState, ChainStore, ConsensusEngine, Mempool,
    MultiValidatorConsensus, StakeRegistry, Validator,
};
use noetis_crypto::{create_wallet, derive_node_id, wallet_from_private_key, Wallet};
use noetis_currency::FAUCET_AMOUNT;
use noetis_p2p::{GossipNetwork, MessageHandler, PeerInfo};
use noetis_protocol::{Block, P2pMessage, P2pMessageType, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::trace::TraceLayer;
use tracing::info;

#[derive(Parser)]
#[command(name = "noetis-full-node")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Start(StartArgs),
}

#[derive(Parser)]
struct StartArgs {
    #[arg(long, default_value = "./data/full-node")]
    data: String,
    #[arg(long, default_value = "4001")]
    p2p_port: u16,
    #[arg(long, default_value = "4000")]
    http_port: u16,
    #[arg(long, default_value = "")]
    bootstrap: String,
    #[arg(long)]
    validator: bool,
    #[arg(long, default_value = "./data/full-node/wallet.json")]
    wallet: String,
}

#[derive(Clone)]
struct AppState {
    node_id: String,
    validator_id: String,
    is_validator: bool,
    network: Arc<GossipNetwork>,
    chain: Arc<RwLock<BlockchainState>>,
    mempool: Arc<RwLock<Mempool>>,
    store: Arc<ChainStore>,
    stake_registry: Arc<RwLock<StakeRegistry>>,
    pending_blocks: Arc<RwLock<HashMap<String, AttestedBlock>>>,
    me: Validator,
    consensus: Arc<MultiValidatorConsensus>,
}

#[derive(Deserialize)]
struct WalletFile {
    private_key: String,
    #[serde(default)]
    box_secret_key: Option<String>,
}

fn load_wallet(path: &str) -> Result<Wallet> {
    let path = PathBuf::from(path);
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let w = create_wallet();
        let data = json!({
            "address": w.address,
            "public_key": w.public_key,
            "private_key": w.private_key,
            "box_public_key": w.box_public_key,
            "box_secret_key": hex::encode(w.box_secret_key.to_bytes()),
        });
        fs::write(&path, serde_json::to_string_pretty(&data)?)?;
        info!("Created validator wallet: {}", w.address);
        return Ok(w);
    }
    let raw = fs::read_to_string(&path)?;
    let file: WalletFile = serde_json::from_str(&raw)?;
    Ok(wallet_from_private_key(
        &file.private_key,
        file.box_secret_key.as_deref(),
    ))
}

fn init_chain(
    data_dir: &str,
    wallet: &Wallet,
    validator_id: &str,
    bootstraps: &[String],
) -> Result<BlockchainState> {
    let store = ChainStore::new(FsPath::new(data_dir).join("chain.json"));
    let me = Validator {
        id: validator_id.to_string(),
        public_key: wallet.public_key.clone(),
        wallet: wallet.clone(),
        stake: Some(100.0),
    };

    if let Some(loaded) = store.load() {
        if !loaded.chain.is_empty() {
            return Ok(BlockchainState {
                chain: loaded.chain,
                validators: vec![me],
                pending_transactions: vec![],
                pending_settlements: vec![],
            });
        }
    }

    if !bootstraps.is_empty() {
        info!("Joining network — waiting for chain sync from bootstrap peer...");
        return Ok(BlockchainState {
            chain: vec![],
            validators: vec![me],
            pending_transactions: vec![],
            pending_settlements: vec![],
        });
    }

    let state = create_blockchain(vec![me.clone()]);
    store.save_state(&state, &[])?;
    Ok(state)
}

async fn finalize_block(state: &AppState, block: AttestedBlock) {
    let mut chain = state.chain.write().await;
    if chain.chain.is_empty() {
        return;
    }
    let latest = get_latest_block(&chain);
    if block.block_number != latest.block_number + 1 || block.hash == latest.hash {
        return;
    }
    if !validate_block_signatures(&block, latest, &chain.validators) {
        return;
    }
    apply_block(&mut chain, block.clone());
    let mempool = state.mempool.read().await;
    let _ = state.store.save_state(&chain, &mempool.list());
    drop(mempool);
    drop(chain);

    let payload = HashMap::from([("block".into(), json!(block))]);
    let _ = state
        .network
        .gossip(P2pMessageType::BlockFinal, payload, 2)
        .await;
    info!(
        "Block #{} finalized",
        block.block_number
    );
}

fn make_handler(state: AppState) -> MessageHandler {
    Arc::new(move |msg: P2pMessage, peer_id: String| {
        let state = state.clone();
        Box::pin(async move {
            match msg.msg_type {
                P2pMessageType::TxGossip => {
                    if let Some(tx_val) = msg.payload.get("tx") {
                        if let Ok(tx) = serde_json::from_value::<Transaction>(tx_val.clone()) {
                            let mut mempool = state.mempool.write().await;
                            if mempool.add(tx.clone()) {
                                drop(mempool);
                                let _ = state
                                    .network
                                    .gossip(
                                        P2pMessageType::TxGossip,
                                        HashMap::from([("tx".into(), json!(tx))]),
                                        2,
                                    )
                                    .await;
                            }
                        }
                    }
                }
                P2pMessageType::BlockProposed => {
                    if let Some(block_val) = msg.payload.get("block") {
                        if let Ok(block) = serde_json::from_value::<AttestedBlock>(block_val.clone())
                        {
                            state
                                .pending_blocks
                                .write()
                                .await
                                .insert(block.hash.clone(), block.clone());

                            if state.is_validator {
                                let attested = attest_block(&block, &state.me);
                                state
                                    .pending_blocks
                                    .write()
                                    .await
                                    .insert(attested.hash.clone(), attested.clone());
                                let _ = state
                                    .network
                                    .gossip(
                                        P2pMessageType::BlockAttest,
                                        HashMap::from([("block".into(), json!(attested.clone()))]),
                                        2,
                                    )
                                    .await;

                                let sig_count = attested
                                    .validator_signatures
                                    .as_ref()
                                    .map(|s| s.len())
                                    .unwrap_or(0);
                                if sig_count >= state.consensus.quorum() {
                                    let hash = attested.hash.clone();
                                    finalize_block(&state, attested).await;
                                    state.pending_blocks.write().await.remove(&hash);
                                }
                            }
                        }
                    }
                }
                P2pMessageType::BlockAttest => {
                    if let Some(block_val) = msg.payload.get("block") {
                        if let Ok(block) = serde_json::from_value::<AttestedBlock>(block_val.clone())
                        {
                            state
                                .pending_blocks
                                .write()
                                .await
                                .insert(block.hash.clone(), block.clone());
                            let sig_count = block
                                .validator_signatures
                                .as_ref()
                                .map(|s| s.len())
                                .unwrap_or(0);
                            if sig_count >= state.consensus.quorum() {
                                finalize_block(&state, block.clone()).await;
                                state.pending_blocks.write().await.remove(&block.hash);
                            }
                        }
                    }
                }
                P2pMessageType::BlockFinal => {
                    if let Some(block_val) = msg.payload.get("block") {
                        if let Ok(block) = serde_json::from_value::<AttestedBlock>(block_val.clone())
                        {
                            finalize_block(&state, block).await;
                        }
                    }
                }
                P2pMessageType::ChainRequest => {
                    let chain = state.chain.read().await;
                    let _ = state
                        .network
                        .send_direct(
                            &peer_id,
                            P2pMessageType::ChainResponse,
                            HashMap::from([("chain".into(), json!(chain.chain))]),
                        )
                        .await;
                }
                P2pMessageType::ChainResponse => {
                    if let Some(chain_val) = msg.payload.get("chain") {
                        if let Ok(remote_chain) =
                            serde_json::from_value::<Vec<Block>>(chain_val.clone())
                        {
                            let mut chain = state.chain.write().await;
                            if remote_chain.is_empty()
                                || remote_chain.len() <= chain.chain.len()
                            {
                                return;
                            }
                            let test = BlockchainState {
                                chain: remote_chain.clone(),
                                validators: chain.validators.clone(),
                                pending_transactions: vec![],
                                pending_settlements: vec![],
                            };
                            if !validate_chain(&test) {
                                return;
                            }
                            chain.chain = remote_chain;
                            let mempool = state.mempool.read().await;
                            let _ = state.store.save_state(&chain, &mempool.list());
                            info!("Synced chain to height {}", chain.chain.len() - 1);
                        }
                    }
                }
                P2pMessageType::Hello => {
                    let chain = state.chain.read().await;
                    let _ = state
                        .network
                        .send_direct(
                            &peer_id,
                            P2pMessageType::ChainResponse,
                            HashMap::from([("chain".into(), json!(chain.chain))]),
                        )
                        .await;
                }
                P2pMessageType::TaskOffer => {
                    if let Some(task_id) = msg.payload.get("task_id").and_then(|v| v.as_str()) {
                        info!("Task offer received: {}...", &task_id[..task_id.len().min(8)]);
                    }
                }
                _ => {}
            }
        })
    })
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    let chain = state.chain.read().await;
    let height = get_block_height(&chain);
    Json(json!({ "ok": true, "node_id": state.node_id, "height": height }))
}

async fn chain(State(state): State<AppState>) -> Json<Value> {
    let chain = state.chain.read().await;
    Json(json!({
        "chain": chain.chain,
        "height": get_block_height(&chain)
    }))
}

async fn balance(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Json<Value> {
    let chain = state.chain.read().await;
    let txs: Vec<Vec<Transaction>> = chain.chain.iter().map(|b| b.transactions.clone()).collect();
    let account = derive_state_from_chain(&txs);
    Json(json!({
        "address": address,
        "balance": account.balances.get(&address).copied().unwrap_or(0.0)
    }))
}

async fn peers(State(state): State<AppState>) -> Json<Vec<PeerInfo>> {
    Json(state.network.list_peers().await)
}

async fn validators(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.stake_registry.read().await.to_json()))
}

async fn submit_tx(
    State(state): State<AppState>,
    Json(tx): Json<Transaction>,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let mut mempool = state.mempool.write().await;
    if mempool.add(tx.clone()) {
        drop(mempool);
        let _ = state
            .network
            .gossip(
                P2pMessageType::TxGossip,
                HashMap::from([("tx".into(), json!(tx.clone()))]),
                2,
            )
            .await;
        Ok((StatusCode::CREATED, Json(json!({ "accepted": true, "id": tx.id }))))
    } else {
        Err(StatusCode::CONFLICT)
    }
}

#[derive(Deserialize)]
struct FaucetBody {
    address: Option<String>,
}

async fn faucet(
    State(state): State<AppState>,
    Json(body): Json<FaucetBody>,
) -> Result<Json<Value>, StatusCode> {
    let address = body.address.ok_or(StatusCode::BAD_REQUEST)?;
    let tx = create_tx(
        noetis_protocol::TransactionType::FaucetTransfer,
        Some("faucet-dev-only"),
        Some(&address),
        FAUCET_AMOUNT,
        HashMap::from([("note".into(), json!("DEVELOPMENT ONLY"))]),
    );
    let mut mempool = state.mempool.write().await;
    mempool.add(tx.clone());
    drop(mempool);
    let _ = state
        .network
        .gossip(
            P2pMessageType::TxGossip,
            HashMap::from([("tx".into(), json!(tx.clone()))]),
            2,
        )
        .await;
    Ok(Json(json!({
        "amount": FAUCET_AMOUNT,
        "tx_id": tx.id,
        "warning": "Dev-only test NOET"
    })))
}

async fn task_offer(
    State(state): State<AppState>,
    Json(offer): Json<Value>,
) -> Json<Value> {
    let task_id = offer.get("task_id").cloned();
    let mut payload: HashMap<String, Value> = offer
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let _ = state.network.gossip(P2pMessageType::TaskOffer, payload, 3).await;
    Json(json!({ "gossiped": true, "task_id": task_id }))
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

async fn run(args: StartArgs) -> Result<()> {
    let wallet = load_wallet(&args.wallet)?;
    let node_id = derive_node_id(&wallet.public_key);
    let validator_id = std::env::var("VALIDATOR_ID")
        .unwrap_or_else(|_| format!("validator-{}", &node_id[..6.min(node_id.len())]));

    let bootstraps: Vec<String> = if args.bootstrap.is_empty() {
        vec![]
    } else {
        vec![args.bootstrap.clone()]
    };

    let mut state = init_chain(&args.data, &wallet, &validator_id, &bootstraps)?;
    let store = Arc::new(ChainStore::new(
        FsPath::new(&args.data).join("chain.json"),
    ));
    let mempool = Arc::new(RwLock::new(Mempool::new()));
    let stake_registry = Arc::new(RwLock::new(StakeRegistry::new()));
    stake_registry.write().await.register(noetis_blockchain::StakeEntry {
        validator_id: validator_id.clone(),
        address: wallet.address.clone(),
        stake: 100.0,
        slashed: 0.0,
    });

    let me = Validator {
        id: validator_id.clone(),
        public_key: wallet.public_key.clone(),
        wallet: wallet.clone(),
        stake: Some(100.0),
    };
    if !state.validators.iter().any(|v| v.id == validator_id) {
        state.validators.push(me.clone());
    }

    let consensus = Arc::new(MultiValidatorConsensus::new(state.validators.clone()));
    let public_host = std::env::var("NOETIS_PUBLIC_HOST")
        .or_else(|_| std::env::var("PUBLIC_HOST"))
        .ok();

    let network = Arc::new(GossipNetwork::new(
        node_id.clone(),
        wallet.clone(),
        args.p2p_port,
        public_host,
    ));

    let app_state = AppState {
        node_id: node_id.clone(),
        validator_id: validator_id.clone(),
        is_validator: args.validator,
        network: network.clone(),
        chain: Arc::new(RwLock::new(state)),
        mempool: mempool.clone(),
        store,
        stake_registry,
        pending_blocks: Arc::new(RwLock::new(HashMap::new())),
        me: me.clone(),
        consensus: consensus.clone(),
    };

    for msg_type in [
        P2pMessageType::TxGossip,
        P2pMessageType::BlockProposed,
        P2pMessageType::BlockAttest,
        P2pMessageType::BlockFinal,
        P2pMessageType::ChainRequest,
        P2pMessageType::ChainResponse,
        P2pMessageType::Hello,
        P2pMessageType::TaskOffer,
    ] {
        network.on(msg_type, make_handler(app_state.clone())).await;
    }

    network
        .start(bootstraps.clone())
        .await
        .map_err(|e| anyhow::anyhow!("failed to start P2P network: {e}"))?;
    info!("Full node {} listening P2P 0.0.0.0:{}", node_id, args.p2p_port);

    // Chain sync loop
    let sync_state = app_state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
        loop {
            interval.tick().await;
            let len = sync_state.chain.read().await.chain.len();
            if len > 0 {
                break;
            }
            let _ = sync_state
                .network
                .broadcast(P2pMessageType::ChainRequest, HashMap::new())
                .await;
        }
    });
    let _ = app_state
        .network
        .broadcast(P2pMessageType::ChainRequest, HashMap::new())
        .await;

    // Validator block production
    if args.validator {
        let prod_state = app_state.clone();
        let block_time = std::env::var("BLOCK_TIME_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(15_000u64);
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_millis(block_time));
            loop {
                interval.tick().await;
                let chain = prod_state.chain.read().await;
                if chain.chain.is_empty() {
                    continue;
                }
                let next_height = get_block_height(&chain) + 1;
                let proposer = get_proposer(&chain.validators, next_height);
                if proposer.id != prod_state.validator_id {
                    continue;
                }
                drop(chain);

                let txs = prod_state.mempool.write().await.drain();
                if txs.is_empty() {
                    continue;
                }

                let mut chain = prod_state.chain.write().await;
                chain.pending_transactions = txs.clone();
                let block = propose_block(&chain, &prod_state.me);
                chain.pending_transactions.clear();
                drop(chain);

                let _ = prod_state
                    .network
                    .gossip(
                        P2pMessageType::BlockProposed,
                        HashMap::from([("block".into(), json!(block))]),
                        2,
                    )
                    .await;
                info!("Proposed block #{} with {} tx(s)", block.block_number, txs.len());
            }
        });
    }

    let router = Router::new()
        .route("/health", get(health))
        .route("/chain", get(chain))
        .route("/chain/balance/{address}", get(balance))
        .route("/peers", get(peers))
        .route("/validators", get(validators))
        .route("/tx", post(submit_tx))
        .route("/faucet", post(faucet))
        .route("/task-offer", post(task_offer))
        .layer(TraceLayer::new_for_http())
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", args.http_port))
        .await
        .context("bind http")?;
    info!("Full node HTTP API :{}", args.http_port);
    info!("Validator mode: {}", args.validator);
    info!(
        "Bootstraps: {}",
        if bootstraps.is_empty() {
            "none (seed node)".to_string()
        } else {
            bootstraps.join(", ")
        }
    );

    axum::serve(listener, router).await?;
    Ok(())
}
