//! Noetis MLC wallet CLI (Rust) — create, stake, transfer, faucet, SPV-verify.
//! Port of `wallet_cli.py`; talks to any Noetis hub (Python or Rust).

use clap::{Parser, Subcommand};
use noetis_chain::spv::verify_account_proof;
use noetis_chain::state::MIN_STAKE;
use noetis_chain::wallet::Wallet;
use noetis_network::data_dir;
use noetis_network::httpc::{get_json, post_json};
use serde_json::{json, Value};

#[derive(Parser)]
#[command(name = "noetis-wallet", about = "Noetis MLC wallet (Ed25519)")]
struct Args {
    #[arg(long, default_value = "default")]
    name: String,
    #[arg(long, default_value = "http://127.0.0.1:5052")]
    hub: String,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create a new wallet
    Create,
    /// Show wallet address and on-chain balance
    Show,
    /// Stake MLC for a compute node
    Stake {
        #[arg(long)]
        node_id: String,
        #[arg(long, default_value_t = MIN_STAKE)]
        amount: f64,
    },
    /// Signed MLC transfer
    Transfer {
        #[arg(long)]
        to: String,
        #[arg(long)]
        amount: f64,
    },
    /// Request onboarding faucet credits
    Faucet {
        #[arg(long, default_value_t = 100.0)]
        amount: f64,
    },
    /// Fetch and verify an SPV balance proof
    Proof,
}

fn wallet_dir() -> std::path::PathBuf {
    data_dir().join("wallets")
}

fn fetch_nonce(hub: &str, address: &str) -> i64 {
    get_json(hub, &format!("/api/wallet/nonce?address={address}"), 30)
        .ok()
        .and_then(|value| value.get("nonce").and_then(Value::as_i64))
        .unwrap_or(0)
}

fn print_json(value: &Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
}

fn main() {
    let args = Args::parse();
    match args.command {
        Command::Create => {
            let existed = Wallet::load(&wallet_dir(), &args.name).is_some();
            let wallet = Wallet::get_or_create(&wallet_dir(), &args.name);
            if existed {
                println!("Wallet '{}' already exists.", args.name);
            }
            println!("Wallet:  {}", wallet.name);
            println!("Address: {}", wallet.address);
            println!("Saved:   {}", wallet_dir().join(format!("{}.json", wallet.name)).display());
        }
        Command::Show => {
            let Some(wallet) = Wallet::load(&wallet_dir(), &args.name) else {
                eprintln!("No wallet found. Run: noetis-wallet create");
                std::process::exit(1);
            };
            print_json(&wallet.to_public_dict());
            match get_json(&args.hub, &format!("/api/wallet/balance?address={}", wallet.address), 30) {
                Ok(balance) => print_json(&balance),
                Err(error) => println!("Could not fetch balance: {error}"),
            }
        }
        Command::Stake { node_id, amount } => {
            let wallet = Wallet::get_or_create(&wallet_dir(), &args.name);
            let nonce = fetch_nonce(&args.hub, &wallet.address);
            let tx = wallet.sign_transaction(&json!({
                "type": "stake",
                "from": wallet.address,
                "amount": amount,
                "node_id": node_id,
                "nonce": nonce,
                "timestamp": noetis_chain::now(),
            }));
            match post_json(&args.hub, "/api/transfer", &tx, 30) {
                Ok(result) => print_json(&result),
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
        Command::Transfer { to, amount } => {
            let wallet = Wallet::get_or_create(&wallet_dir(), &args.name);
            let nonce = fetch_nonce(&args.hub, &wallet.address);
            let tx = wallet.sign_transaction(&json!({
                "type": "transfer",
                "from": wallet.address,
                "to": to,
                "amount": amount,
                "nonce": nonce,
                "timestamp": noetis_chain::now(),
            }));
            match post_json(&args.hub, "/api/transfer", &tx, 30) {
                Ok(result) => print_json(&result),
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
        Command::Faucet { amount } => {
            let wallet = Wallet::get_or_create(&wallet_dir(), &args.name);
            match post_json(
                &args.hub,
                "/api/faucet",
                &json!({"address": wallet.address, "amount": amount}),
                30,
            ) {
                Ok(result) => print_json(&result),
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
        Command::Proof => {
            let Some(wallet) = Wallet::load(&wallet_dir(), &args.name) else {
                eprintln!("No wallet found. Run: noetis-wallet create");
                std::process::exit(1);
            };
            match get_json(&args.hub, &format!("/api/wallet/proof?address={}", wallet.address), 30) {
                Ok(proof) => {
                    let ok = verify_account_proof(&proof);
                    print_json(&proof);
                    println!("SPV verification: {}", if ok { "VERIFIED" } else { "INVALID" });
                    if !ok {
                        std::process::exit(1);
                    }
                }
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
    }
}
