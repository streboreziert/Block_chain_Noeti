//! Federation networking — cosignature collection, chain unification, and
//! peer registration. Port of Python `consensus.py` + `federation_auto.py`.

use crate::httpc::{get_json, post_json};
use noetis_chain::validators::{verify_cosignature_crypto, ValidatorInfo, Validators};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn federation_peers_env() -> Vec<String> {
    std::env::var("FEDERATION_PEERS")
        .unwrap_or_default()
        .split(',')
        .map(|item| item.trim().trim_end_matches('/').to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// Push our committed chain so a lagging peer catches up before cosigning.
pub fn sync_peer_to_tip(peer_url: &str, blocks: &[Value]) {
    let payload = json!({"blocks": blocks, "length": blocks.len()});
    let _ = post_json(peer_url, "/api/chain/sync", &payload, 60);
}

/// Python `collect_cosignatures` — ask every federation peer to cosign,
/// fast-forwarding lagging peers once.
pub fn collect_cosignatures(
    block: &Value,
    local: &ValidatorInfo,
    known: &BTreeMap<String, ValidatorInfo>,
    local_chain_blocks: &[Value],
) -> Vec<Value> {
    let local_url = local.hub_url.trim_end_matches('/');
    let proof = block.get("proof").cloned().unwrap_or(Value::Null);
    let block_hash = block.get("hash").and_then(Value::as_str).unwrap_or("");
    let mut cosignatures = Vec::new();

    for peer in known.values() {
        let peer_url = peer.hub_url.trim_end_matches('/');
        if peer_url.is_empty() || peer_url == local_url || peer.public_key == local.public_key {
            continue;
        }
        let mut cosign = request_cosign(peer_url, block);
        let valid = cosign
            .as_ref()
            .map(|c| verify_cosignature_crypto(c, &proof, block_hash))
            .unwrap_or(false);
        if !valid {
            sync_peer_to_tip(peer_url, local_chain_blocks);
            cosign = request_cosign(peer_url, block);
        }
        if let Some(c) = cosign {
            if verify_cosignature_crypto(&c, &proof, block_hash) {
                cosignatures.push(c);
            }
        }
    }
    cosignatures
}

fn request_cosign(peer_url: &str, block: &Value) -> Option<Value> {
    post_json(peer_url, "/api/chain/cosign", &json!({"block": block}), 8)
        .ok()
        .and_then(|result| result.get("cosignature").cloned())
        .filter(|c| !c.is_null())
}

/// Register ourselves with a peer hub (signed registration).
pub fn register_self_with_peer(peer_url: &str, public_url: &str, validators: &Validators) -> Result<Value, String> {
    let info = validators.info();
    let timestamp = noetis_chain::now();
    let body = json!({
        "hub_url": public_url,
        "validator_id": info.validator_id,
        "public_key": info.public_key,
        "address": info.address,
        "timestamp": timestamp,
        "from": info.address,
    });
    let signed = validators.wallet.sign_transaction(&body);
    let signature = signed.get("signature").and_then(Value::as_str).unwrap_or("");
    post_json(
        peer_url,
        "/api/validator/register",
        &json!({
            "hub_url": public_url,
            "validator_id": info.validator_id,
            "public_key": info.public_key,
            "address": info.address,
            "timestamp": timestamp,
            "signature": signature,
        }),
        10,
    )
}

/// Import a peer's validator identity (trust-on-bootstrap).
pub fn import_peer_validator(peer_url: &str, validators: &Validators) -> Result<Value, String> {
    let remote = get_json(peer_url, "/api/validator", 10)?;
    Ok(validators.register_peer_trusted(
        peer_url,
        remote.get("validator_id").and_then(Value::as_str).unwrap_or(""),
        remote.get("public_key").and_then(Value::as_str).unwrap_or(""),
        remote.get("address").and_then(Value::as_str).unwrap_or(""),
    ))
}

pub fn fetch_remote_blocks(hub_url: &str) -> Result<Vec<Value>, String> {
    let payload = get_json(hub_url, "/api/chain/full", 30)?;
    payload
        .get("blocks")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Invalid chain payload from hub".into())
}
