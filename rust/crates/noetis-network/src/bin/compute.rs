//! Noetis compute node (Rust) — E2E encrypted tasks + signed attestations.
//! Interoperates with Python hubs; port of `compute.py`.
//!
//! On graceful exit (Ctrl+C / normal return), unregisters from the hub so the
//! mesh slot clears immediately. SIGKILL cannot run Drop — the parent app must
//! call leave_network in that case.

use clap::Parser;
use noetis_chain::attestation::build_attestation;
use noetis_chain::state::MIN_STAKE;
use noetis_chain::taskcrypto::{decrypt_task, encrypt_response, generate_enc_keypair};
use noetis_chain::wallet::Wallet;
use noetis_network::httpc::{get_json, post_json};
use noetis_network::ollama::OllamaClient;
use noetis_network::{data_dir, lan_ip};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// POSTs `/api/compute/unregister` when dropped after a successful register.
struct UnregisterGuard {
    hub: String,
    node_id: String,
}

impl Drop for UnregisterGuard {
    fn drop(&mut self) {
        // Best-effort leave — hub may already be gone.
        match post_json(
            &self.hub,
            "/api/compute/unregister",
            &json!({ "node_id": self.node_id }),
            8,
        ) {
            Ok(_) => println!("[unregister] left network as {}", self.node_id),
            Err(e) => eprintln!("[unregister] warn: {e}"),
        }
    }
}

#[derive(Parser)]
#[command(name = "noetis-compute", about = "Join the Noetis network as a compute provider")]
struct Args {
    #[arg(long, default_value = "http://127.0.0.1:5052")]
    hub: String,
    #[arg(long = "id")]
    node_id: String,
    #[arg(long, default_value = "qwen2.5:0.5b")]
    model: String,
    #[arg(long, default_value = "")]
    wallet: String,
    #[arg(long, default_value = "")]
    access_url: String,
}

fn load_enc_keys(node_id: &str) -> (String, String) {
    let dir = data_dir().join("wallets");
    let path = dir.join(format!("enc-{node_id}.json"));
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if let (Some(pub_key), Some(priv_key)) = (
                value.get("enc_pubkey").and_then(Value::as_str),
                value.get("enc_privkey").and_then(Value::as_str),
            ) {
                return (pub_key.to_string(), priv_key.to_string());
            }
        }
    }
    let (pub_key, priv_key) = generate_enc_keypair();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&json!({"enc_pubkey": pub_key, "enc_privkey": priv_key})).unwrap(),
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    (pub_key, priv_key)
}

fn ensure_stake(hub: &str, wallet_name: &str, node_id: &str) -> Result<Wallet, String> {
    let wallet = Wallet::get_or_create(&data_dir().join("wallets"), wallet_name);
    let status = get_json(
        hub,
        &format!(
            "/api/staking/status?address={}&node_id={node_id}",
            wallet.address
        ),
        30,
    )?;
    if status
        .get("eligible")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        println!("[wallet] already eligible · {}", wallet.address);
        return Ok(wallet);
    }

    let balance = get_json(
        hub,
        &format!("/api/wallet/balance?address={}", wallet.address),
        30,
    )?;
    let mut total = balance
        .get("total")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if total < MIN_STAKE {
        match post_json(
            hub,
            "/api/faucet",
            &json!({"address": wallet.address, "amount": 100}),
            30,
        ) {
            Ok(_) => {
                println!("[wallet] Faucet credited MLC to {}", wallet.address);
                std::thread::sleep(std::time::Duration::from_millis(400));
                let balance = get_json(
                    hub,
                    &format!("/api/wallet/balance?address={}", wallet.address),
                    30,
                )?;
                total = balance
                    .get("total")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
            }
            Err(e) => {
                return Err(format!(
                    "Need {MIN_STAKE} MLC to stake for node `{node_id}` — transfer MLC or earn; faucet is off. ({e})"
                ));
            }
        }
    }
    if total < MIN_STAKE {
        return Err(format!(
            "Wallet {} still has {total} MLC (need {MIN_STAKE}) — transfer MLC or earn; faucet is off.",
            wallet.address
        ));
    }

    let nonce = get_json(
        hub,
        &format!("/api/wallet/nonce?address={}", wallet.address),
        30,
    )?
    .get("nonce")
    .and_then(Value::as_i64)
    .unwrap_or(0);
    let stake_tx = wallet.sign_transaction(&json!({
        "type": "stake",
        "from": wallet.address,
        "amount": MIN_STAKE,
        "node_id": node_id,
        "nonce": nonce,
        "timestamp": noetis_chain::now(),
    }));
    post_json(hub, "/api/transfer", &stake_tx, 30)
        .map_err(|e| format!("stake tx failed for node `{node_id}`: {e}"))?;
    println!("[wallet] Staked {MIN_STAKE} MLC on-chain for {node_id}");

    // Confirm eligibility so register won't bounce
    std::thread::sleep(std::time::Duration::from_millis(400));
    let status = get_json(
        hub,
        &format!(
            "/api/staking/status?address={}&node_id={node_id}",
            wallet.address
        ),
        30,
    )?;
    if !status
        .get("eligible")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(format!(
            "Stake submitted but hub says not eligible yet for `{node_id}`. Wait a few seconds and retry Earn."
        ));
    }
    Ok(wallet)
}

fn main() {
    let args = Args::parse();
    let mut client = OllamaClient::new(&args.model);
    if !client.is_available() {
        eprintln!("ERROR: Ollama not running. Install https://ollama.com and run: ollama serve");
        std::process::exit(1);
    }
    let model = match client.resolve_model(&[&args.model, "qwen2.5:0.5b", "llama3.2:1b"]) {
        Ok(m) => m,
        Err(error) => {
            eprintln!("ERROR: {error}");
            std::process::exit(1);
        }
    };

    let wallet_name = if args.wallet.is_empty() {
        format!("compute-{}", args.node_id)
    } else {
        args.wallet.clone()
    };
    let wallet = match ensure_stake(&args.hub, &wallet_name, &args.node_id) {
        Ok(w) => w,
        Err(error) => {
            eprintln!("ERROR: {error}");
            std::process::exit(1);
        }
    };
    let (enc_pubkey, enc_privkey) = load_enc_keys(&args.node_id);

    println!("Compute node: {}", args.node_id);
    println!("Wallet:       {}", wallet.address);
    println!("E2E encrypt:  {}…", &enc_pubkey[..20.min(enc_pubkey.len())]);
    println!("Hub:          {}", args.hub);
    println!("Model:        {model}");
    println!("Waiting for inference tasks… (Ctrl+C to stop)\n");

    let access_url = if args.access_url.trim().is_empty() {
        format!("http://{}:11434", lan_ip())
    } else {
        args.access_url.trim().to_string()
    };

    if let Err(error) = post_json(
        &args.hub,
        "/api/compute/register",
        &json!({
            "node_id": args.node_id,
            "model": model,
            "wallet_address": wallet.address,
            "enc_pubkey": enc_pubkey,
            "access_url": access_url,
        }),
        30,
    ) {
        eprintln!("ERROR: register failed: {error}");
        std::process::exit(1);
    }
    println!("[register] ok — listed on hub as {}", args.node_id);

    // Unregister on graceful shutdown (Drop). Ctrl+C breaks the loop so Drop runs.
    // Note: SIGKILL cannot run Drop — parent app leave_network must clear the slot.
    let _leave = UnregisterGuard {
        hub: args.hub.clone(),
        node_id: args.node_id.clone(),
    };

    let running = Arc::new(AtomicBool::new(true));
    {
        let flag = running.clone();
        if let Err(e) = ctrlc::set_handler(move || {
            // Exit the poll loop so `_leave` Drop POSTs unregister (process::exit skips Drop).
            flag.store(false, Ordering::SeqCst);
        }) {
            eprintln!("[warn] ctrlc handler not installed: {e}");
        }
    }

    while running.load(Ordering::SeqCst) {
        let cycle = || -> Result<(), String> {
            post_json(&args.hub, "/api/compute/heartbeat", &json!({"node_id": args.node_id}), 30)?;
            // Mesh-first: offers → claim, then poll fallback.
            let mut task = json!({});
            if let Ok(offers_payload) = get_json(
                &args.hub,
                &format!("/api/compute/offers?node_id={}", args.node_id),
                30,
            ) {
                if let Some(offers) = offers_payload.get("offers").and_then(Value::as_array) {
                    if let Some(first) = offers.first() {
                        if let Some(tid) = first.get("task_id").and_then(Value::as_str) {
                            if let Ok(claimed) = post_json(
                                &args.hub,
                                "/api/compute/claim",
                                &json!({"node_id": args.node_id, "task_id": tid}),
                                30,
                            ) {
                                task = claimed;
                            }
                        }
                    }
                }
            }
            if task.get("task_id").and_then(Value::as_str).is_none() {
                task = get_json(
                    &args.hub,
                    &format!("/api/compute/poll?node_id={}", args.node_id),
                    30,
                )?;
            }
            let Some(task_id) = task.get("task_id").and_then(Value::as_str).map(str::to_string) else {
                return Ok(());
            };
            let prompt = decrypt_task(&task, &enc_privkey).ok_or("Failed to decrypt task")?;
            let prompt_hash = task.get("prompt_hash").and_then(Value::as_str).unwrap_or("").to_string();
            let num_predict = task
                .get("num_predict")
                .or_else(|| task.get("max_tokens"))
                .and_then(Value::as_i64)
                .map(|n| n.clamp(128, 2048));
            println!("[task] {task_id}: {}…", prompt.chars().take(80).collect::<String>());

            let result = client.generate_with_options(&prompt, num_predict)?;
            let attestation = build_attestation(
                &wallet,
                &task_id,
                &result.model,
                &result.response,
                result.inference_ms,
                &prompt_hash,
            );
            let mut body = json!({
                "task_id": task_id,
                "node_id": args.node_id,
                "response": result.response,
                "inference_ms": result.inference_ms,
                "model": result.model,
                "attestation": attestation,
            });
            let encrypted = task.get("encrypted").and_then(Value::as_bool).unwrap_or(false);
            if encrypted {
                if let Some(hub_ephem) = task.get("ephem_pubkey").and_then(Value::as_str) {
                    if let Some(enc) = encrypt_response(&result.response, hub_ephem, &enc_privkey) {
                        for (key, value) in enc.as_object().cloned().unwrap_or_default() {
                            body[key] = value;
                        }
                        body["response"] = json!("");
                    }
                }
            }
            post_json(&args.hub, "/api/compute/result", &body, 30)?;
            println!("[done] {task_id} in {:.0}ms (attested)", result.inference_ms);
            Ok(())
        };
        if let Err(error) = cycle() {
            eprintln!("[warn] {error}");
        }
        if !running.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    println!("[stop] shutting down compute…");
}
