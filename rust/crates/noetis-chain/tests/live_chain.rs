//! Cross-verification against a snapshot of the LIVE noeticompute.com chain
//! produced by the Python hub. Every hash, signature, and state root must
//! reproduce exactly — this is the wire-compatibility proof.

use noetis_chain::chain::{Chain, TrustMode};
use noetis_chain::spv::{account_proof, state_root, verify_account_proof};
use noetis_chain::state::rebuild_state_from_chain;
use noetis_chain::validators::{signature_count, verify_block_signature, verify_cosignature_crypto};
use serde_json::Value;

fn fixture() -> Value {
    let raw = include_str!("fixtures/live_chain.json");
    serde_json::from_str(raw).expect("fixture parses")
}

fn fixture_blocks() -> Vec<Value> {
    fixture().get("blocks").and_then(Value::as_array).cloned().expect("blocks")
}

#[test]
fn block_hashes_reproduce_exactly() {
    let blocks = fixture_blocks();
    assert!(!blocks.is_empty());
    let parsed = Chain::from_payload(std::path::Path::new("/tmp"), &blocks).expect("parse blocks");
    for (value, block) in blocks.iter().zip(&parsed) {
        let claimed = value.get("hash").and_then(Value::as_str).unwrap();
        assert_eq!(
            block.compute_hash(),
            claimed,
            "hash mismatch at block {}",
            block.index
        );
    }
}

#[test]
fn producer_signatures_verify() {
    let blocks = fixture_blocks();
    for value in &blocks {
        let proof = value.get("proof").unwrap();
        let hash = value.get("hash").and_then(Value::as_str).unwrap();
        assert!(
            verify_block_signature(proof, hash),
            "producer signature failed at block {}",
            value.get("index").unwrap()
        );
    }
}

#[test]
fn cosignatures_verify() {
    let blocks = fixture_blocks();
    let mut checked = 0;
    for value in &blocks {
        let proof = value.get("proof").unwrap();
        let hash = value.get("hash").and_then(Value::as_str).unwrap();
        for cosign in proof.get("cosignatures").and_then(Value::as_array).cloned().unwrap_or_default() {
            assert!(
                verify_cosignature_crypto(&cosign, proof, hash),
                "cosignature failed at block {}",
                value.get("index").unwrap()
            );
            checked += 1;
        }
        assert!(signature_count(proof, hash, None) >= 1);
    }
    assert!(checked > 0, "fixture should contain at least one cosignature");
}

#[test]
fn state_roots_reproduce_exactly() {
    let blocks = fixture_blocks();
    let mut rolling: Vec<Value> = Vec::new();
    for value in &blocks {
        rolling.push(value.clone());
        let state = rebuild_state_from_chain(&rolling);
        let claimed = value
            .get("proof")
            .and_then(|p| p.get("state_root"))
            .and_then(Value::as_str)
            .unwrap();
        assert_eq!(
            state_root(&state),
            claimed,
            "state root mismatch at block {}",
            value.get("index").unwrap()
        );
    }
    // Top-level snapshot state root too.
    let snapshot_root = fixture().get("state_root").and_then(Value::as_str).unwrap().to_string();
    assert_eq!(state_root(&rebuild_state_from_chain(&rolling)), snapshot_root);
}

#[test]
fn full_structure_and_state_validation_passes() {
    let blocks = fixture_blocks();
    let parsed = Chain::from_payload(std::path::Path::new("/tmp"), &blocks).unwrap();
    let probe = Chain::probe(std::path::Path::new("/tmp"), parsed);
    assert!(probe.is_valid_structure(&TrustMode::CryptoOnly, true), "structure invalid");
    assert!(probe.is_valid_state(), "state invalid");
}

#[test]
fn tampering_is_detected() {
    let mut blocks = fixture_blocks();
    // Inflate a balance inside a credit transaction.
    if let Some(tx) = blocks[0]
        .get_mut("proof")
        .and_then(|p| p.get_mut("transactions"))
        .and_then(|t| t.get_mut(0))
    {
        tx["amount"] = serde_json::json!(9999999.0);
    }
    let parsed = Chain::from_payload(std::path::Path::new("/tmp"), &blocks).unwrap();
    let probe = Chain::probe(std::path::Path::new("/tmp"), parsed);
    let structure_ok = probe.is_valid_structure(&TrustMode::CryptoOnly, true);
    let state_ok = probe.is_valid_state();
    assert!(!(structure_ok && state_ok), "tampered chain must fail validation");
}

#[test]
fn spv_proofs_roundtrip_for_every_account() {
    let blocks = fixture_blocks();
    let state = rebuild_state_from_chain(&blocks);
    assert!(!state.is_empty());
    let root = state_root(&state);
    for address in state.keys() {
        let proof = account_proof(&state, address).expect("proof exists");
        assert_eq!(proof.get("state_root").and_then(Value::as_str).unwrap(), root);
        assert!(verify_account_proof(&proof), "SPV proof failed for {address}");
    }
}
