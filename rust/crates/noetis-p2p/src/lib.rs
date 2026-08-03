use futures_util::{SinkExt, StreamExt};
use noetis_crypto::{sign_payload, Wallet};
use noetis_protocol::{P2pMessage, P2pMessageType};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;
use tokio_tungstenite::{accept_async, connect_async, tungstenite::Message, WebSocketStream};
use uuid::Uuid;

pub type MessageHandler = Arc<
    dyn Fn(P2pMessage, String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync,
>;

#[derive(Debug, Clone, serde::Serialize)]
pub struct PeerInfo {
    pub id: String,
    pub url: String,
    pub connected: bool,
}

struct PeerConnection {
    tx: mpsc::UnboundedSender<String>,
    connected: bool,
}

struct NetworkInner {
    peers: HashMap<String, PeerConnection>,
}

#[derive(Clone)]
struct NetworkContext {
    node_id: String,
    wallet: Wallet,
    listen_port: u16,
    public_host: Option<String>,
    inner: Arc<RwLock<NetworkInner>>,
    handlers: Arc<RwLock<HashMap<P2pMessageType, Vec<MessageHandler>>>>,
    seen: Arc<RwLock<HashSet<String>>>,
    reconnect_tasks: Arc<RwLock<HashMap<String, JoinHandle<()>>>>,
    reconnecting: Arc<RwLock<HashSet<String>>>,
}

pub struct GossipNetwork {
    ctx: NetworkContext,
    server_task: Arc<RwLock<Option<JoinHandle<()>>>>,
    peer_list_task: Arc<RwLock<Option<JoinHandle<()>>>>,
}

impl GossipNetwork {
    pub fn new(
        node_id: String,
        wallet: Wallet,
        listen_port: u16,
        public_host: Option<String>,
    ) -> Self {
        Self {
            ctx: NetworkContext {
                node_id,
                wallet,
                listen_port,
                public_host,
                inner: Arc::new(RwLock::new(NetworkInner {
                    peers: HashMap::new(),
                })),
                handlers: Arc::new(RwLock::new(HashMap::new())),
                seen: Arc::new(RwLock::new(HashSet::new())),
                reconnect_tasks: Arc::new(RwLock::new(HashMap::new())),
                reconnecting: Arc::new(RwLock::new(HashSet::new())),
            },
            server_task: Arc::new(RwLock::new(None)),
            peer_list_task: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn start(&self, bootstrap_urls: Vec<String>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let listener = TcpListener::bind(format!("0.0.0.0:{}", self.ctx.listen_port)).await?;
        let ctx = self.ctx.clone();

        let server = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let temp_id = format!("inbound:{}", &Uuid::new_v4().to_string()[..8]);
                spawn_inbound_connection(ctx.clone(), stream, temp_id);
            }
        });
        *self.server_task.write().await = Some(server);

        for url in bootstrap_urls {
            connect_outbound(&self.ctx, url).await;
        }

        let ctx = self.ctx.clone();
        let peer_list = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                let peers = list_peers(&ctx).await;
                let payload = HashMap::from([(
                    "peers".into(),
                    serde_json::to_value(peers).unwrap_or(json!([])),
                )]);
                let _ = broadcast(&ctx, P2pMessageType::PeerList, payload).await;
            }
        });
        *self.peer_list_task.write().await = Some(peer_list);

        Ok(())
    }

    pub async fn on(&self, msg_type: P2pMessageType, handler: MessageHandler) {
        let mut handlers = self.ctx.handlers.write().await;
        handlers.entry(msg_type).or_default().push(handler);
    }

    pub async fn list_peers(&self) -> Vec<PeerInfo> {
        list_peers(&self.ctx).await
    }

    pub async fn connect(&self, url: &str) {
        connect_outbound(&self.ctx, url.to_string()).await;
    }

    pub async fn broadcast(
        &self,
        msg_type: P2pMessageType,
        payload: HashMap<String, Value>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        broadcast(&self.ctx, msg_type, payload).await
    }

    pub async fn send_direct(
        &self,
        peer_id: &str,
        msg_type: P2pMessageType,
        payload: HashMap<String, Value>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let inner = self.ctx.inner.read().await;
        let Some(peer) = inner.peers.get(peer_id) else {
            return Ok(());
        };
        if !peer.connected {
            return Ok(());
        }
        let msg = create_message(&self.ctx, msg_type, payload).await;
        let raw = serde_json::to_string(&msg)?;
        let _ = peer.tx.send(raw);
        Ok(())
    }

    pub async fn gossip(
        &self,
        msg_type: P2pMessageType,
        mut payload: HashMap<String, Value>,
        ttl: i64,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        payload.insert("_ttl".into(), json!(ttl));
        self.broadcast(msg_type, payload).await
    }

    pub async fn stop(&self) {
        if let Some(task) = self.server_task.write().await.take() {
            task.abort();
        }
        if let Some(task) = self.peer_list_task.write().await.take() {
            task.abort();
        }
        for (_, task) in self.ctx.reconnect_tasks.write().await.drain() {
            task.abort();
        }
        self.ctx.inner.write().await.peers.clear();
    }
}

async fn list_peers(ctx: &NetworkContext) -> Vec<PeerInfo> {
    let inner = ctx.inner.read().await;
    inner
        .peers
        .iter()
        .map(|(id, peer)| PeerInfo {
            id: id.clone(),
            url: id.clone(),
            connected: peer.connected,
        })
        .collect()
}

async fn broadcast(
    ctx: &NetworkContext,
    msg_type: P2pMessageType,
    payload: HashMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let msg = create_message(ctx, msg_type, payload).await;
    let raw = serde_json::to_string(&msg)?;
    let inner = ctx.inner.read().await;
    for peer in inner.peers.values() {
        if peer.connected {
            let _ = peer.tx.send(raw.clone());
        }
    }
    Ok(())
}

async fn create_message(
    ctx: &NetworkContext,
    msg_type: P2pMessageType,
    payload: HashMap<String, Value>,
) -> P2pMessage {
    let signature = sign_payload(&payload_to_btree(&payload), &ctx.wallet);
    P2pMessage {
        msg_type,
        message_id: Uuid::new_v4().to_string(),
        timestamp: now_ms(),
        sender_id: ctx.node_id.clone(),
        payload,
        signature,
    }
}

fn spawn_inbound_connection(ctx: NetworkContext, stream: TcpStream, peer_id: String) {
    tokio::spawn(async move {
        let Ok(ws_stream) = accept_async(stream).await else {
            return;
        };
        run_connection(ctx, peer_id, ws_stream, true).await;
    });
}

async fn connect_outbound(ctx: &NetworkContext, url: String) {
    spawn_outbound_connect(ctx.clone(), url);
}

fn spawn_outbound_connect(ctx: NetworkContext, url: String) {
    tokio::spawn(async move {
        if ctx.inner.read().await.peers.contains_key(&url) {
            return;
        }
        let Ok((ws_stream, _)) = connect_async(&url).await else {
            spawn_reconnect(ctx, url);
            return;
        };
        run_connection(ctx, url, ws_stream, false).await;
    });
}

fn spawn_reconnect(ctx: NetworkContext, url: String) {
    tokio::spawn(async move {
        {
            let mut reconnecting = ctx.reconnecting.write().await;
            if !reconnecting.insert(url.clone()) {
                return;
            }
        }

        let ctx_task = ctx.clone();
        let url_task = url.clone();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                interval.tick().await;
                if ctx_task.inner.read().await.peers.contains_key(&url_task) {
                    break;
                }
                let Ok((ws_stream, _)) = connect_async(&url_task).await else {
                    continue;
                };
                run_connection(ctx_task.clone(), url_task.clone(), ws_stream, false).await;
                if ctx_task.inner.read().await.peers.contains_key(&url_task) {
                    break;
                }
            }
            ctx_task.reconnect_tasks.write().await.remove(&url_task);
            ctx_task.reconnecting.write().await.remove(&url_task);
        });
        ctx.reconnect_tasks.write().await.insert(url, task);
    });
}

async fn run_connection<S>(
    ctx: NetworkContext,
    peer_id: String,
    ws_stream: WebSocketStream<S>,
    inbound: bool,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws_stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    {
        let mut inner = ctx.inner.write().await;
        inner.peers.insert(
            peer_id.clone(),
            PeerConnection {
                tx: tx.clone(),
                connected: true,
            },
        );
    }

    if !inbound {
        let hello_payload = HashMap::from([
            ("node_id".into(), json!(ctx.node_id)),
            ("listen_port".into(), json!(ctx.listen_port)),
            (
                "public_host".into(),
                json!(ctx.public_host.clone().unwrap_or_else(|| "127.0.0.1".into())),
            ),
        ]);
        let msg = create_message(&ctx, P2pMessageType::Hello, hello_payload).await;
        if let Ok(raw) = serde_json::to_string(&msg) {
            let _ = tx.send(raw);
        }
    }

    let ctx_writer = ctx.clone();
    let peer_id_writer = peer_id.clone();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
        unregister_peer(&ctx_writer.inner, &peer_id_writer).await;
    });

    let mut current_peer_id = peer_id.clone();
    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Some(new_id) = handle_incoming(&ctx, &text, &current_peer_id).await {
                    current_peer_id = new_id;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    unregister_peer(&ctx.inner, &current_peer_id).await;
    writer.abort();

    if !inbound {
        spawn_reconnect(ctx, peer_id);
    }
}

async fn rekey_peer(inner: &Arc<RwLock<NetworkInner>>, old_id: &str, new_id: &str) {
    if old_id == new_id {
        return;
    }
    let mut guard = inner.write().await;
    if let Some(conn) = guard.peers.remove(old_id) {
        guard.peers.insert(new_id.to_string(), conn);
    }
}

async fn unregister_peer(inner: &Arc<RwLock<NetworkInner>>, peer_id: &str) {
    let mut guard = inner.write().await;
    guard.peers.remove(peer_id);
}

async fn handle_incoming(ctx: &NetworkContext, raw: &str, peer_id: &str) -> Option<String> {
    let msg: P2pMessage = serde_json::from_str(raw).ok()?;
    {
        let mut seen = ctx.seen.write().await;
        if seen.contains(&msg.message_id) {
            return None;
        }
        seen.insert(msg.message_id.clone());
        if seen.len() > 10_000 {
            seen.clear();
        }
    }

    let mut current_peer = peer_id.to_string();

    if msg.msg_type == P2pMessageType::Hello {
        if let Some(remote_id) = msg.payload.get("node_id").and_then(|v| v.as_str()) {
            rekey_peer(&ctx.inner, peer_id, remote_id).await;
            current_peer = remote_id.to_string();

            let listen_port = msg.payload.get("listen_port").and_then(|v| v.as_i64());
            let host = msg
                .payload
                .get("public_host")
                .and_then(|v| v.as_str())
                .unwrap_or("127.0.0.1");
            if let Some(port) = listen_port {
                let url = peer_url(host, port as u16);
                if !ctx.inner.read().await.peers.contains_key(&url) {
                    spawn_outbound_connect(ctx.clone(), url);
                }
            }
        }
    }

    let ttl = msg
        .payload
        .get("_ttl")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if ttl > 0 {
        let mut forwarded = msg.payload.clone();
        forwarded.insert("_ttl".into(), json!(ttl - 1));
        let _ = broadcast(ctx, msg.msg_type.clone(), forwarded).await;
    }

    let handlers = ctx.handlers.read().await;
    if let Some(list) = handlers.get(&msg.msg_type) {
        for h in list {
            h(msg.clone(), current_peer.clone()).await;
        }
    }

    Some(current_peer)
}

pub fn peer_url(host: &str, port: u16) -> String {
    format!("ws://{host}:{port}")
}

fn payload_to_btree(payload: &HashMap<String, Value>) -> BTreeMap<String, Value> {
    payload.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
