//! Debug helper: verify a signed transaction JSON file against the Rust
//! canonicalization. Usage: cargo run -p noetis-chain --example verify_tx -- FILE

use noetis_chain::pyjson::dumps_canonical;
use noetis_chain::wallet::verify_signature;
use serde_json::Value;

fn main() {
    let path = std::env::args().nth(1).expect("usage: verify_tx FILE");
    let raw = std::fs::read_to_string(path).expect("read file");
    let tx: Value = serde_json::from_str(&raw).expect("parse json");
    let mut body = tx.as_object().cloned().unwrap();
    body.remove("signature");
    println!("CANON: {}", dumps_canonical(&Value::Object(body)));
    println!("VERIFY_RS: {}", verify_signature(&tx));
}
