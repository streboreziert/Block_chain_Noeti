//! E2E task encryption — X25519 + AES-256-GCM, wire-compatible with Python
//! `task_crypto.py` (shared key = SHA-256 of the raw X25519 exchange).

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn b64_decode(data: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

fn shared_key(private: &StaticSecret, public: &PublicKey) -> [u8; 32] {
    let raw = private.diffie_hellman(public);
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hasher.finalize().into()
}

fn parse_public(hex_key: &str) -> Option<PublicKey> {
    let bytes: [u8; 32] = hex::decode(hex_key).ok()?.try_into().ok()?;
    Some(PublicKey::from(bytes))
}

fn parse_private(hex_key: &str) -> Option<StaticSecret> {
    let bytes: [u8; 32] = hex::decode(hex_key).ok()?.try_into().ok()?;
    Some(StaticSecret::from(bytes))
}

/// Returns (public_hex, private_hex).
pub fn generate_enc_keypair() -> (String, String) {
    let private = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&private);
    (hex::encode(public.as_bytes()), hex::encode(private.to_bytes()))
}

/// Hub side: encrypt a prompt to a compute node's public key with an ephemeral key.
/// The returned map includes `_hub_ephem_priv` for decrypting the response.
pub fn encrypt_task(prompt: &str, compute_enc_pubkey_hex: &str) -> Option<Value> {
    let peer = parse_public(compute_enc_pubkey_hex)?;
    let ephemeral = StaticSecret::random_from_rng(OsRng);
    let ephem_public = PublicKey::from(&ephemeral);
    let key = shared_key(&ephemeral, &peer);

    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let mut nonce_bytes = [0u8; 12];
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce_bytes), prompt.as_bytes()).ok()?;

    Some(json!({
        "encrypted": true,
        "ciphertext": b64(&ciphertext),
        "nonce": b64(&nonce_bytes),
        "ephem_pubkey": hex::encode(ephem_public.as_bytes()),
        "_hub_ephem_priv": hex::encode(ephemeral.to_bytes()),
    }))
}

/// Compute side: decrypt a task payload (returns plaintext prompt).
pub fn decrypt_task(payload: &Value, compute_enc_privkey_hex: &str) -> Option<String> {
    if !payload.get("encrypted").and_then(Value::as_bool).unwrap_or(false) {
        return Some(payload.get("prompt").and_then(Value::as_str).unwrap_or("").to_string());
    }
    let ephem_public = parse_public(payload.get("ephem_pubkey").and_then(Value::as_str)?)?;
    let private = parse_private(compute_enc_privkey_hex)?;
    let key = shared_key(&private, &ephem_public);
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let nonce = b64_decode(payload.get("nonce").and_then(Value::as_str)?)?;
    let ciphertext = b64_decode(payload.get("ciphertext").and_then(Value::as_str)?)?;
    let plain = cipher.decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice()).ok()?;
    String::from_utf8(plain).ok()
}

/// Compute side: encrypt the response back to the hub's ephemeral key.
pub fn encrypt_response(response: &str, hub_ephem_pubkey_hex: &str, compute_enc_privkey_hex: &str) -> Option<Value> {
    let hub_public = parse_public(hub_ephem_pubkey_hex)?;
    let private = parse_private(compute_enc_privkey_hex)?;
    let key = shared_key(&private, &hub_public);
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let mut nonce_bytes = [0u8; 12];
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce_bytes), response.as_bytes()).ok()?;
    Some(json!({
        "response_encrypted": true,
        "response_ciphertext": b64(&ciphertext),
        "response_nonce": b64(&nonce_bytes),
    }))
}

/// Hub side: decrypt an encrypted response.
pub fn decrypt_response(
    response_payload: &Value,
    hub_ephem_priv_hex: &str,
    compute_enc_pubkey_hex: &str,
) -> Option<String> {
    if !response_payload
        .get("response_encrypted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some(
            response_payload
                .get("response")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        );
    }
    let hub_private = parse_private(hub_ephem_priv_hex)?;
    let compute_public = parse_public(compute_enc_pubkey_hex)?;
    let key = shared_key(&hub_private, &compute_public);
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let nonce = b64_decode(response_payload.get("response_nonce").and_then(Value::as_str)?)?;
    let ciphertext = b64_decode(response_payload.get("response_ciphertext").and_then(Value::as_str)?)?;
    let plain = cipher.decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice()).ok()?;
    String::from_utf8(plain).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e2e_roundtrip() {
        let (compute_pub, compute_priv) = generate_enc_keypair();
        let task = encrypt_task("what is 2+2?", &compute_pub).unwrap();
        let prompt = decrypt_task(&task, &compute_priv).unwrap();
        assert_eq!(prompt, "what is 2+2?");

        let hub_ephem_pub = task.get("ephem_pubkey").unwrap().as_str().unwrap();
        let hub_ephem_priv = task.get("_hub_ephem_priv").unwrap().as_str().unwrap();
        let response = encrypt_response("4", hub_ephem_pub, &compute_priv).unwrap();
        let plain = decrypt_response(&response, hub_ephem_priv, &compute_pub).unwrap();
        assert_eq!(plain, "4");
    }
}
