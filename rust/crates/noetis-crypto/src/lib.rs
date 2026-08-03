use base64::{engine::general_purpose::STANDARD as B64, Engine};
use crypto_box::{PublicKey as BoxPublicKey, SecretKey as BoxSecretKey, aead::Aead, SalsaBox};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct Wallet {
    pub address: String,
    pub public_key: String,
    pub private_key: String,
    pub signing_key: SigningKey,
    pub box_public_key: String,
    pub box_secret_key: BoxSecretKey,
}

pub fn hash(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn hash_str(data: &str) -> String {
    hash(data.as_bytes())
}

pub fn derive_address(public_key_hex: &str) -> String {
    let bytes = hex::decode(public_key_hex).unwrap_or_default();
    let digest = Sha256::digest(&bytes);
    format!("noet1{}", hex::encode(&digest[..20]))
}

pub fn derive_node_id(public_key_hex: &str) -> String {
    hash_str(public_key_hex)[..32].to_string()
}

pub fn create_wallet() -> Wallet {
    let signing_key = SigningKey::generate(&mut OsRng);
    wallet_from_signing_key(signing_key, None)
}

pub fn wallet_from_private_key(private_key_hex: &str, box_secret_hex: Option<&str>) -> Wallet {
    let sk_bytes = hex::decode(private_key_hex).expect("invalid private key hex");
    let sk: [u8; 32] = sk_bytes.try_into().expect("private key must be 32 bytes");
    let signing_key = SigningKey::from_bytes(&sk);
    wallet_from_signing_key(signing_key, box_secret_hex)
}

fn wallet_from_signing_key(signing_key: SigningKey, box_secret_hex: Option<&str>) -> Wallet {
    let verifying_key = signing_key.verifying_key();
    let public_key = hex::encode(verifying_key.as_bytes());
    let (box_secret_key, box_public_key) = if let Some(hex_sk) = box_secret_hex {
        let sk_bytes = hex::decode(hex_sk).expect("invalid box secret");
        let sk: [u8; 32] = sk_bytes.try_into().expect("box secret 32 bytes");
        let sk = BoxSecretKey::from(sk);
        let pk = sk.public_key();
        (sk, pk)
    } else {
        let sk = BoxSecretKey::generate(&mut OsRng);
        let pk = sk.public_key();
        (sk, pk)
    };
    Wallet {
        address: derive_address(&public_key),
        public_key: public_key.clone(),
        private_key: hex::encode(signing_key.to_bytes()),
        signing_key,
        box_public_key: hex::encode(box_public_key.as_bytes()),
        box_secret_key,
    }
}

pub fn sign_message(message: &str, wallet: &Wallet) -> String {
    let sig = wallet.signing_key.sign(message.as_bytes());
    B64.encode(sig.to_bytes())
}

pub fn verify_signature(message: &str, signature_b64: &str, public_key_hex: &str) -> bool {
    let Ok(sig_bytes) = B64.decode(signature_b64) else {
        return false;
    };
    let Ok(pk_bytes) = hex::decode(public_key_hex) else {
        return false;
    };
    let Ok(pk_arr): Result<[u8; 32], _> = pk_bytes.try_into() else {
        return false;
    };
    let Ok(sig_arr): Result<[u8; 64], _> = sig_bytes.try_into() else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&pk_arr) else {
        return false;
    };
    let signature = ed25519_dalek::Signature::from_bytes(&sig_arr);
    verifying_key.verify(message.as_bytes(), &signature).is_ok()
}

pub fn canonical_message(payload: &BTreeMap<String, Value>) -> String {
    serde_json::to_string(payload).unwrap_or_default()
}

pub fn sign_payload(payload: &BTreeMap<String, Value>, wallet: &Wallet) -> String {
    sign_message(&canonical_message(payload), wallet)
}

pub fn verify_payload_signature(
    payload: &BTreeMap<String, Value>,
    signature: &str,
    public_key_hex: &str,
) -> bool {
    verify_signature(&canonical_message(payload), signature, public_key_hex)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EncryptedPayload {
    pub ciphertext: String,
    pub nonce: String,
    pub ephemeral_public_key: String,
}

pub fn encrypt_for_recipient(plaintext: &str, recipient_box_public_key_hex: &str) -> EncryptedPayload {
    let pk_bytes = hex::decode(recipient_box_public_key_hex).expect("invalid box public key");
    let pk_arr: [u8; 32] = pk_bytes.try_into().expect("box pk 32 bytes");
    let recipient_pk = BoxPublicKey::from(pk_arr);
    let ephemeral_sk = BoxSecretKey::generate(&mut OsRng);
    let ephemeral_pk = ephemeral_sk.public_key();
    let salsa = SalsaBox::new(&recipient_pk, &ephemeral_sk);
    let mut nonce_bytes = [0u8; 24];
    rand::RngCore::fill_bytes(&mut OsRng, &mut nonce_bytes);
    let nonce = crypto_box::Nonce::from(nonce_bytes);
    let ciphertext = salsa.encrypt(&nonce, plaintext.as_bytes()).expect("encrypt");
    EncryptedPayload {
        ciphertext: B64.encode(ciphertext),
        nonce: B64.encode(nonce_bytes),
        ephemeral_public_key: hex::encode(ephemeral_pk.as_bytes()),
    }
}

pub fn decrypt_from_sender(
    ciphertext_b64: &str,
    nonce_b64: &str,
    ephemeral_public_key_hex: &str,
    recipient_secret_key: &BoxSecretKey,
) -> anyhow::Result<String> {
    let ciphertext = B64.decode(ciphertext_b64)?;
    let nonce_bytes: [u8; 24] = B64.decode(nonce_b64)?.try_into().map_err(|_| anyhow::anyhow!("bad nonce"))?;
    let nonce = crypto_box::Nonce::from(nonce_bytes);
    let eph_bytes = hex::decode(ephemeral_public_key_hex)?;
    let eph_arr: [u8; 32] = eph_bytes.try_into().map_err(|_| anyhow::anyhow!("bad eph pk"))?;
    let ephemeral_pk = BoxPublicKey::from(eph_arr);
    let salsa = SalsaBox::new(&ephemeral_pk, recipient_secret_key);
    let opened = salsa
        .decrypt(&nonce, ciphertext.as_ref())
        .map_err(|_| anyhow::anyhow!("decrypt failed"))?;
    Ok(String::from_utf8(opened)?)
}

pub fn estimate_tokens(text: &str) -> i64 {
    ((text.len() as f64 / 4.0).ceil() as i64).max(1)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthChallenge {
    pub wallet_address: String,
    pub timestamp: i64,
    pub nonce: String,
}

pub fn verify_auth_challenge(
    challenge: &AuthChallenge,
    signature: &str,
    public_key_hex: &str,
    max_age_ms: i64,
) -> bool {
    let now = chrono_timestamp_ms();
    if (now - challenge.timestamp).abs() > max_age_ms {
        return false;
    }
    let mut map = BTreeMap::new();
    map.insert("nonce".into(), Value::String(challenge.nonce.clone()));
    map.insert("timestamp".into(), Value::Number(challenge.timestamp.into()));
    map.insert(
        "wallet_address".into(),
        Value::String(challenge.wallet_address.clone()),
    );
    verify_signature(&canonical_message(&map), signature, public_key_hex)
}

fn chrono_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
