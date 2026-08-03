# Security model & checklist

Threats considered, mitigations implemented, and how to audit them yourself with
`python3 security_check.py`.

---

## 1. Blockchain integrity

| Threat | Mitigation |
|--------|------------|
| Forged blocks | Every block sealed with hub validator **Ed25519 signature**; peers verify against the validator set before accepting |
| Single malicious validator | **Cosignature quorum** — with ≥2 federated validators, blocks need 2 signatures (`COSIGN_QUORUM=2`) |
| Balance tampering | **Merkle state root** in every block; sync replays all transactions and rejects mismatching roots |
| Concurrent forks at the same height | **Deterministic proposer schedule** (round-robin by height over sorted validator keys) + tiebreak: scheduled proposer's block wins, else lower hash — every hub resolves identically |
| Deep chain rewrite (history/balance rewrite) | **Finality checkpoint** — reorgs deeper than `MAX_REORG_DEPTH` (default 24) are refused; genesis mismatch refused |
| Silent history loss | A stored chain that fails validation is **backed up and the node refuses to start** (no silent genesis regeneration) unless `ALLOW_CHAIN_RESET=1` |
| Unauthorized minting | `/api/transfer` accepts **only signed transaction types**; `credit`/`slash` are producer-internal and rejected over the API |
| Sybil validators | On-chain validators require a **100 MLC stake** (`validator_register` tx); stake withdrawn/slashed below threshold removes the validator |
| Replay attacks | Per-address **nonce** on every transaction; duplicate nonces rejected in mempool and state transition |
| Fake balances for light clients | **SPV Merkle account proofs** (`/api/wallet/proof`) verified client-side |
| Inference result divergence | **Deterministic decoding** (temperature 0, seed 42, greedy) so honest nodes produce identical output; consensus compares like with like; outliers slashed |

## 2. Compute / consensus security

| Threat | Mitigation |
|--------|------------|
| Fake inference results | Multi-node dispatch; majority **consensus vote** on outputs; only matching results are rewarded |
| Sybil compute nodes | **10 MLC stake** required per (wallet, node_id) before a node can register |
| Persistent bad actors | **Slashing** (1 MLC per violation) burned from stake on consensus mismatch |
| Model spoofing | Signed **model attestation** on every result (model name, output hash, timing) verifiable against the node's wallet key |

## 3. Data-in-transit security

| Channel | Protection |
|---------|-----------|
| User → hub | TLS (Let's Encrypt via Traefik) |
| Hub → compute prompt | **X25519 + AES-256-GCM** end-to-end (hub can't be MITM'd from outside; other nodes can't read) |
| Compute → hub response | Encrypted to hub's ephemeral key |
| Hub ↔ hub federation | TLS + Ed25519-signed registration payloads (timestamped) |

## 4. Data-at-rest security

- Prompts/responses: **never written to disk or chain** — hashes only.
- Wallet private keys: local files `chmod 600` in `connection-layer/data/wallets/`;
  browser wallets in device local storage only.
- E2E node keys: local file `chmod 600`, public half registered with hub.
- Server chain data: Docker volume, no secrets inside.

## 5. API / server hardening

- **Rate limits** (Redis-backed, file fallback): `/api/infer`, `/api/faucet`
  (1 claim / wallet / 24 h, max 50 MLC), `/api/chain/sync` (6/min/IP).
- **CORS**: API allows only `http://127.0.0.1:*` / `localhost` origins (local apps);
  no wildcard.
- **Security headers**: `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, HSTS via Traefik.
- Faucet in production: `ALLOW_FAUCET=limited` — cannot drain treasury.
- Gunicorn (no Flask dev server) behind Traefik; only 80/443 + mesh ports exposed.

## 6. Run the audit yourself

```bash
python3 security_check.py                       # local node audit
python3 security_check.py --hub https://noeticompute.com   # remote hub audit
```

Checks performed:

1. Chain structure valid (hash links, Merkle roots)
2. Chain state valid (transaction replay, no negative balances)
3. Genesis version matches (v4)
4. Validator signatures verify on latest blocks
5. Cosign quorum configuration
6. Wallet/key file permissions (must be 0600)
7. HTTPS on the public hub URL
8. Faucet mode is `limited` (production) not `1`
9. Rate limiting active
10. `/api/wallet/proof` SPV proof verifies

Exit code 0 = all pass; non-zero = at least one failure, printed with details.

## 7. Reporting

Found a vulnerability? Email `dev@noeticompute.com`. Don't open a public issue for
exploitable bugs.
