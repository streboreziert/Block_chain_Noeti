//! Model attestation — signed proof that compute ran the claimed model.
//! Port of Python `attestation.py`.

use crate::pyjson::{round1, sha256_text};
use crate::wallet::{verify_signature, Wallet};
use serde_json::{json, Value};

pub fn model_digest(model: &str) -> String {
    sha256_text(model.trim())
}

pub fn build_attestation(
    wallet: &Wallet,
    task_id: &str,
    model: &str,
    response: &str,
    inference_ms: f64,
    prompt_hash: &str,
) -> Value {
    let body = json!({
        "type": "model_attestation",
        "from": wallet.address,
        "public_key": wallet.public_key_hex,
        "task_id": task_id,
        "model": model,
        "model_hash": model_digest(model),
        "output_hash": sha256_text(response),
        "prompt_hash": prompt_hash,
        "inference_ms": round1(inference_ms),
        "timestamp": crate::now(),
    });
    wallet.sign_transaction(&body)
}

pub fn verify_attestation(attestation: &Value) -> Result<(), String> {
    if attestation.get("type").and_then(Value::as_str) != Some("model_attestation") {
        return Err("Invalid attestation type".into());
    }
    if !verify_signature(attestation) {
        return Err("Invalid attestation signature".into());
    }
    let model = attestation.get("model").and_then(Value::as_str).unwrap_or("");
    if attestation.get("model_hash").and_then(Value::as_str) != Some(model_digest(model).as_str()) {
        return Err("Model hash mismatch".into());
    }
    Ok(())
}
