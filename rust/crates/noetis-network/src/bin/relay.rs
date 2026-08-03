//! Noetis relay node (Rust) — routes user prompts to compute anonymously.
//! Port of `relay.py`; interoperates with Python hubs.

use clap::Parser;
use noetis_network::httpc::{get_json, post_json};
use noetis_network::lan_ip;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Parser)]
#[command(name = "noetis-relay", about = "Join the Noetis network as a relay")]
struct Args {
    #[arg(long, default_value = "http://127.0.0.1:5052")]
    hub: String,
    #[arg(long = "id")]
    relay_id: String,
    #[arg(long, default_value = "")]
    access_url: String,
}

fn main() {
    let args = Args::parse();
    let access_url = if args.access_url.trim().is_empty() {
        format!("relay://{}", lan_ip())
    } else {
        args.access_url.trim().to_string()
    };

    println!("Relay node:  {}", args.relay_id);
    println!("Hub:         {}", args.hub);
    println!("Role:        route user prompts to compute — user identity stays hidden");
    println!("Waiting for tasks to relay… (Ctrl+C to stop)\n");

    if let Err(error) = post_json(
        &args.hub,
        "/api/relay/register",
        &json!({"relay_id": args.relay_id, "access_url": access_url}),
        30,
    ) {
        eprintln!("ERROR: {error}");
        std::process::exit(1);
    }

    loop {
        let cycle = || -> Result<(), String> {
            post_json(&args.hub, "/api/relay/heartbeat", &json!({"relay_id": args.relay_id}), 30)?;
            let task = get_json(&args.hub, &format!("/api/relay/poll?relay_id={}", args.relay_id), 30)?;
            if let Some(task_id) = task.get("task_id").and_then(Value::as_str) {
                println!("[relay] {task_id}: forwarding anonymous task to compute pool");
                post_json(
                    &args.hub,
                    "/api/relay/forward",
                    &json!({"relay_id": args.relay_id, "task_id": task_id}),
                    30,
                )?;
                println!("[relay] {task_id}: forwarded — compute never sees user");
            }
            Ok(())
        };
        if let Err(error) = cycle() {
            eprintln!("[warn] {error}");
        }
        std::thread::sleep(Duration::from_millis(800));
    }
}
