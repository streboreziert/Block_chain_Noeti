//! Compare Rust python_float_repr against a corpus of Python-repr floats.
//! Usage: cargo run -p noetis-chain --example float_fuzz -- /tmp/floats.txt

use noetis_chain::pyjson::python_float_repr;

fn main() {
    let path = std::env::args().nth(1).expect("usage: float_fuzz FILE");
    let raw = std::fs::read_to_string(path).expect("read file");
    let mut mismatches = 0;
    let mut total = 0;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        total += 1;
        // Parse through serde_json — the real wire path (requires float_roundtrip).
        let value: f64 = serde_json::from_str(line).expect("parse float");
        let ours = python_float_repr(value);
        if ours != line {
            mismatches += 1;
            if mismatches <= 10 {
                println!("MISMATCH python={line} rust={ours}");
            }
        }
    }
    println!("checked {total} floats, {mismatches} mismatches");
    if mismatches > 0 {
        std::process::exit(1);
    }
}
