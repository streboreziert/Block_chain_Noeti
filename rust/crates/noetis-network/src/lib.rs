//! Noetis network layer — hub, compute, relay, sync, and wallet binaries.
//! Speaks the exact HTTP + gossip protocol of the Python network, so Rust and
//! Python nodes interoperate on the same chain.

pub mod client_static;
pub mod consensus_net;
pub mod gossip;
pub mod httpc;
pub mod hubstate;
pub mod ollama;
pub mod ratelimit;

use std::path::PathBuf;

/// Data directory (wallets, chain.db, federation.json). Defaults to
/// `./data`, override with NOETIS_DATA_DIR.
pub fn data_dir() -> PathBuf {
    std::env::var("NOETIS_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data"))
}

/// Best-effort LAN IP (Python `get_lan_ip`).
pub fn lan_ip() -> String {
    use std::net::UdpSocket;
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|sock| {
            sock.connect("8.8.8.8:80")?;
            sock.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}
