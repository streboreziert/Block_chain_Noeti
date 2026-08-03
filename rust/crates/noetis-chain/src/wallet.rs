//! Ed25519 wallets for MLC — wire-compatible with the Python `crypto_wallet` module.

use crate::pyjson::dumps_canonical;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const ADDRESS_PREFIX: &str = "mlc";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wallet {
    pub name: String,
    pub address: String,
    #[serde(rename = "public_key")]
    pub public_key_hex: String,
    pub private_key_hex: String,
}

impl Wallet {
    pub fn create(name: &str) -> Self {
        let mut secret = [0u8; 32];
        use rand::RngCore;
        rand::rngs::OsRng.fill_bytes(&mut secret);
        let signing = SigningKey::from_bytes(&secret);
        let public_hex = hex::encode(signing.verifying_key().to_bytes());
        Wallet {
            name: name.to_string(),
            address: address_from_public_key(&public_hex),
            public_key_hex: public_hex,
            private_key_hex: hex::encode(secret),
        }
    }

    pub fn sign_payload(&self, payload: &Value) -> String {
        let message = dumps_canonical(payload);
        let secret: [u8; 32] = hex::decode(&self.private_key_hex)
            .expect("wallet private key hex")
            .try_into()
            .expect("wallet private key length");
        let signing = SigningKey::from_bytes(&secret);
        hex::encode(signing.sign(message.as_bytes()).to_bytes())
    }

    /// Python `Wallet.sign_transaction`: strip `signature`, set `public_key`,
    /// sign the canonical body, and return body + signature.
    pub fn sign_transaction(&self, tx: &Value) -> Value {
        let mut body: Map<String, Value> = tx.as_object().cloned().unwrap_or_default();
        body.remove("signature");
        body.insert("public_key".into(), Value::String(self.public_key_hex.clone()));
        let body_value = Value::Object(body.clone());
        let signature = self.sign_payload(&body_value);
        body.insert("signature".into(), Value::String(signature));
        Value::Object(body)
    }

    pub fn to_public_dict(&self) -> Value {
        serde_json::json!({
            "name": self.name,
            "address": self.address,
            "public_key": self.public_key_hex,
        })
    }

    pub fn save(&self, wallet_dir: &Path) -> std::io::Result<PathBuf> {
        fs::create_dir_all(wallet_dir)?;
        let path = wallet_dir.join(format!("{}.json", self.name));
        let payload = serde_json::json!({
            "name": self.name,
            "address": self.address,
            "public_key": self.public_key_hex,
            "private_key_hex": self.private_key_hex,
        });
        fs::write(&path, serde_json::to_string_pretty(&payload)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(path)
    }

    pub fn load(wallet_dir: &Path, name: &str) -> Option<Wallet> {
        let path = wallet_dir.join(format!("{name}.json"));
        let raw = fs::read_to_string(path).ok()?;
        let value: Value = serde_json::from_str(&raw).ok()?;
        Some(Wallet {
            name: value.get("name")?.as_str()?.to_string(),
            address: value.get("address")?.as_str()?.to_string(),
            public_key_hex: value.get("public_key")?.as_str()?.to_string(),
            private_key_hex: value.get("private_key_hex")?.as_str()?.to_string(),
        })
    }

    pub fn get_or_create(wallet_dir: &Path, name: &str) -> Wallet {
        if let Some(existing) = Wallet::load(wallet_dir, name) {
            return existing;
        }
        let wallet = Wallet::create(name);
        let _ = wallet.save(wallet_dir);
        wallet
    }
}

pub fn address_from_public_key(public_key_hex: &str) -> String {
    let take = public_key_hex.len().min(42);
    format!("{ADDRESS_PREFIX}{}", &public_key_hex[..take])
}

pub fn verify_ed25519(public_key_hex: &str, signature_hex: &str, message: &[u8]) -> bool {
    let Ok(pub_bytes) = hex::decode(public_key_hex) else { return false };
    let Ok(pub_arr) = <[u8; 32]>::try_from(pub_bytes.as_slice()) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&pub_arr) else { return false };
    let Ok(sig_bytes) = hex::decode(signature_hex) else { return false };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig_bytes.as_slice()) else { return false };
    let signature = ed25519_dalek::Signature::from_bytes(&sig_arr);
    key.verify(message, &signature).is_ok()
}

/// Python `verify_signature(tx)` — verify a signed transaction dict.
pub fn verify_signature(tx: &Value) -> bool {
    let Some(obj) = tx.as_object() else { return false };
    let signature_hex = obj.get("signature").and_then(Value::as_str).unwrap_or("");
    if signature_hex.is_empty() {
        return false;
    }
    let address = obj.get("from").and_then(Value::as_str).unwrap_or("");
    let mut public_key_hex = obj.get("public_key").and_then(Value::as_str).unwrap_or("").to_string();
    if public_key_hex.is_empty() && address.starts_with(ADDRESS_PREFIX) {
        public_key_hex = address[ADDRESS_PREFIX.len()..].to_string();
    }
    if public_key_hex.len() != 64 {
        return false;
    }
    let mut body = obj.clone();
    body.remove("signature");
    let message = dumps_canonical(&Value::Object(body));
    if !verify_ed25519(&public_key_hex, signature_hex, message.as_bytes()) {
        return false;
    }
    address_from_public_key(&public_key_hex) == address
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sign_and_verify_roundtrip() {
        let wallet = Wallet::create("test");
        let tx = wallet.sign_transaction(&json!({
            "type": "transfer",
            "from": wallet.address,
            "to": "mlcdeadbeef",
            "amount": 10.0,
            "nonce": 0,
            "timestamp": 1784135514.509693,
        }));
        assert!(verify_signature(&tx));
        let mut tampered = tx.clone();
        tampered["amount"] = json!(99.0);
        assert!(!verify_signature(&tampered));
    }
}
