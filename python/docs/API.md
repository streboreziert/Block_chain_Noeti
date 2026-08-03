# Hub API reference

Base URL: `https://noeticompute.com` (or any federated hub). All bodies JSON.
CORS is enabled for `localhost` origins so local apps can call these directly.

---

## Discovery

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/entry.txt` | GET | Plain-text live registry: access points, devices, validator keys |
| `/api/discovery` | GET | Same data as JSON (`access_points[]`, `devices[]`, `validators[]`) |
| `/api/entry` | GET | Entry metadata + join commands |
| `/api/health` | GET | `{ok, chain_length, chain_valid, chain_version}` |
| `/api/status` | GET | Full hub snapshot: nodes, relays, events, chain, mesh, federation |
| `/api/architecture` | GET | Layer descriptions |

## Blockchain

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chain` | GET | Last 12 blocks + state root |
| `/api/chain/full` | GET | Entire chain (full sync) |
| `/api/chain/headers` | GET | Headers only (light clients) |
| `/api/chain/block/<n>` | GET | Single block |
| `/api/chain/sync` | POST | Submit longer valid chain `{blocks:[…]}` (rate-limited 6/min) |
| `/api/chain/cosign` | POST | Request cosignature for a candidate block (federation) |
| `/api/chain/finalize-pending` | POST | Flush mempool into a block |

## Wallet & currency

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/wallet/balance?address=` | GET | `{balance, staked, total}` |
| `/api/wallet/proof?address=` | GET | SPV Merkle proof of balance |
| `/api/wallet/nonce?address=` | GET | Next transaction nonce |
| `/api/transfer` | POST | Signed tx: `transfer` / `stake` / `unstake` |
| `/api/faucet` | POST | `{address}` → 50 MLC (1× / 24 h / wallet) |
| `/api/staking/status?address=&node_id=` | GET | Stake eligibility for compute |
| `/api/transactions` | GET | Recent on-chain transactions |
| `/api/wallets` | GET | All balances (public state) |
| `/api/mempool` | GET | Pending signed transactions |

### Signed transaction format

Canonical JSON (sorted keys, compact separators) signed with Ed25519:

```json
{
  "type": "transfer", "from": "mlc…", "to": "mlc…",
  "amount": 5.0, "nonce": 3, "timestamp": 1784067518.6,
  "public_key": "<hex 64B>", "signature": "<hex 128B>"
}
```

`stake`/`unstake` add `"node_id"`. Address must equal `mlc` + pubkey[:42].

## Inference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/infer` | POST | `{text}` → dispatch to network (rate-limited); poll `/api/status` for `last_task.consensus_response` |

## Compute nodes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/compute/register` | POST | `{node_id, model, wallet_address, enc_pubkey, access_url}` — stake required |
| `/api/compute/heartbeat` | POST | `{node_id}` every few seconds |
| `/api/compute/poll?node_id=` | GET | Next task (E2E encrypted payload) |
| `/api/compute/result` | POST | `{task_id, node_id, enc_response…, attestation}` |

## Relays

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/relay/register` | POST | `{relay_id, access_url}` |
| `/api/relay/heartbeat` | POST | `{relay_id}` |
| `/api/relay/poll?relay_id=` | GET | Next task to forward |
| `/api/relay/forward` | POST | `{relay_id, task_id}` |

## Federation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/validator` | GET | This hub's validator identity |
| `/api/validators` | GET | Known federation validators |
| `/api/validator/register` | POST | Signed peer registration `{hub_url, validator_id, public_key, address, timestamp, signature}` |
| `/api/mesh` | GET | Gossip mesh: port, protocol, live peers |

## Errors

Errors return `{"error": "message"}` with HTTP 400 (bad input), 404, or 429
(rate-limited). Rate limit responses include the reason string.
