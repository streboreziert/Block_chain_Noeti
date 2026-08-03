# Security

## Transport

- Use TLS (`wss://`, `https://`) for all public deployments
- Local development may use unencrypted `ws://` / `http://`

## Authentication

- Wallet signatures (Ed25519) required for task submission
- Replay protection via nonce + timestamp validation
- WebSocket messages include sender signatures for registration and results

## Task payloads

- Encrypted with libsodium-compatible box (Curve25519 + XSalsa20-Poly1305)
- Stored off-chain in Redis with TTL; deleted after task completion
- Only prompt/result **hashes** committed to ledger

## Node safety

- Ollama model names validated against allowlist (when configured)
- No shell command execution from task metadata
- Prompt size limits (100KB)
- Ollama request timeouts (120s default)
- Rate limiting on API (120 req/min)

## Prototype limitations

- Coordinator is a trusted party for routing (not yet decentralized)
- Test NOET has no economic value; slashing is reputation-only
- Single validator PoA — not Byzantine fault tolerant
- Node operators can read decrypted prompts during inference

## Recommendations for production

- Hardware attestation for nodes
- Trusted execution environments (TEE) for prompt processing
- Multi-validator consensus with stake slashing
- Distributed coordinator via libp2p
- Audit logging with no plaintext prompt storage
