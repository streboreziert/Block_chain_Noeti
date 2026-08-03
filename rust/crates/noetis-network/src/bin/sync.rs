//! Noetis sync node (Rust) — download and fully verify a hub's chain.
//! Full mode (whole chain) or light mode (headers + block-by-block).
//! Also verifies SPV wallet proofs. Port of `sync_node.py` + `p2p_sync.py`.

use clap::Parser;
use noetis_chain::chain::{Chain, TrustMode};
use noetis_chain::spv::verify_account_proof;
use noetis_network::data_dir;
use noetis_network::httpc::get_json;
use serde_json::Value;
use std::time::Duration;

#[derive(Parser)]
#[command(name = "noetis-sync", about = "Noetis P2P chain sync + verification node")]
struct Args {
    /// Hub URL, e.g. https://noeticompute.com
    #[arg(long)]
    hub: String,
    /// Light client: headers first, then fetch blocks one by one
    #[arg(long)]
    light: bool,
    /// Sync once and exit
    #[arg(long)]
    once: bool,
    /// Verify an SPV balance proof for this address
    #[arg(long, default_value = "")]
    spv: String,
    #[arg(long, default_value_t = 30.0)]
    interval: f64,
}

fn fetch_full_chain(hub: &str) -> Result<Vec<Value>, String> {
    let payload = get_json(hub, "/api/chain/full", 60)?;
    payload
        .get("blocks")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Invalid chain payload from hub".into())
}

fn verify_blocks(blocks: &[Value]) -> Result<(), String> {
    if blocks.is_empty() {
        return Err("Empty chain rejected".into());
    }
    let data = data_dir();
    let parsed = Chain::from_payload(&data, blocks).ok_or("Malformed blocks")?;
    let probe = Chain::probe(&data, parsed);
    if !probe.is_valid_structure(&TrustMode::CryptoOnly, true) {
        return Err("Invalid block linkage, hashes, or validator signatures".into());
    }
    if !probe.is_valid_state() {
        return Err("Invalid on-chain state transitions or state roots".into());
    }
    Ok(())
}

fn sync_once(args: &Args) -> Result<usize, String> {
    let blocks = if args.light {
        light_sync(&args.hub)?
    } else {
        fetch_full_chain(&args.hub)?
    };
    verify_blocks(&blocks)?;
    // Persist the verified chain in our local store.
    noetis_chain::store::replace_all(&data_dir(), &blocks);
    Ok(blocks.len())
}

fn light_sync(hub: &str) -> Result<Vec<Value>, String> {
    let payload = get_json(hub, "/api/chain/headers", 30)?;
    let headers = payload
        .get("headers")
        .and_then(Value::as_array)
        .cloned()
        .ok_or("Invalid headers payload from hub")?;
    let mut blocks = Vec::new();
    let mut previous_hash = String::from("0");
    for (index, header) in headers.iter().enumerate() {
        let claimed_prev = header.get("previous_hash").and_then(Value::as_str).unwrap_or("");
        if claimed_prev != previous_hash {
            return Err(format!("Header chain broken at #{index}"));
        }
        let block = get_json(hub, &format!("/api/chain/block/{index}"), 30)?;
        let block_hash = block.get("hash").and_then(Value::as_str).unwrap_or("").to_string();
        if Some(block_hash.as_str()) != header.get("hash").and_then(Value::as_str) {
            return Err(format!("Header/block hash mismatch at #{index}"));
        }
        previous_hash = block_hash;
        blocks.push(block);
    }
    Ok(blocks)
}

fn main() {
    let args = Args::parse();
    let mode = if args.light { "light" } else { "full" };
    println!("Chain sync node (Rust)");
    println!("Hub:      {}", args.hub);
    println!("Mode:     {mode}");
    println!();

    if !args.spv.is_empty() {
        match get_json(&args.hub, &format!("/api/wallet/proof?address={}", args.spv), 30) {
            Ok(proof) => {
                let ok = verify_account_proof(&proof);
                println!("SPV proof for {}: {}", args.spv, if ok { "VERIFIED" } else { "INVALID" });
                println!(
                    "  balance={} staked={} state_root={}",
                    proof.get("account").and_then(|a| a.get("balance")).unwrap_or(&Value::Null),
                    proof.get("account").and_then(|a| a.get("staked")).unwrap_or(&Value::Null),
                    proof.get("state_root").and_then(Value::as_str).unwrap_or(""),
                );
                if !ok {
                    std::process::exit(1);
                }
            }
            Err(error) => {
                eprintln!("SPV error: {error}");
                std::process::exit(1);
            }
        }
        if args.once {
            return;
        }
    }

    loop {
        match sync_once(&args) {
            Ok(length) => println!("[sync] ok — verified {length} block(s), every hash + signature + state root checked"),
            Err(error) => eprintln!("[sync] REJECTED: {error}"),
        }
        if args.once {
            break;
        }
        std::thread::sleep(Duration::from_secs_f64(args.interval));
    }
}
