//! # noetis-chain
//!
//! Rust implementation of the Noetis Proof-of-Inference protocol, byte-for-byte
//! wire-compatible with the Python network (`python-network` branch):
//!
//! - MLC currency: signed transfers, staking, slashing, faucet credits
//! - Block hashing over Python-style canonical JSON (SHA-256)
//! - Ed25519 wallets, validator signatures, and federation cosignatures
//! - Merkle state roots + SPV account proofs
//! - X25519 + AES-256-GCM end-to-end task encryption
//! - Model attestations
//! - SQLite block store (same `chain.db` schema as the Python hub)

pub mod attestation;
pub mod block;
pub mod chain;
pub mod pyjson;
pub mod schedule;
pub mod spv;
pub mod state;
pub mod store;
pub mod taskcrypto;
pub mod validators;
pub mod wallet;

/// Unix timestamp as f64 (Python `time.time()`).
pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}
