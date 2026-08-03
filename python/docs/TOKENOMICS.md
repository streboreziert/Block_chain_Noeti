# MLC — the Noetis currency

MLC ("Machine Learning Credit") is the native on-chain currency of the Noetis
Proof-of-Inference blockchain. It is not an ERC-20 or wrapped asset — it exists only in
Noetis chain state, moved by Ed25519-signed transactions inside blocks.

---

## Supply

| Item | Value |
|------|-------|
| Genesis supply | **1,000,000 MLC** minted to the network treasury in block 0 |
| Inflation | None scheduled — new MLC enters circulation only from treasury |
| Smallest unit | 0.000001 MLC (6 decimals) |

The treasury address is derived from the hub treasury wallet and is visible in the
genesis block (`/api/chain/block/0`).

## How MLC enters circulation

1. **Inference rewards** — compute nodes whose result matches consensus earn MLC per
   task, paid from treasury inside the settlement block.
2. **Onboarding faucet** — `ALLOW_FAUCET=limited`: max **50 MLC per wallet per 24 h**
   (production setting). Enough to stake and start earning.
3. **Treasury transfers** — manual grants via `treasury_cli.py` (signed, on-chain).

## How MLC is used

| Use | Amount |
|-----|--------|
| **Stake to provide compute** | 10 MLC minimum, locked per (wallet, node_id) |
| **Slashing** | 1 MLC per consensus violation, burned from stake |
| **Transfers** | free-form signed `transfer` transactions between addresses |

## Transaction types

All transactions are canonical-JSON signed with Ed25519 and carry a nonce
(replay protection):

```json
{"type": "transfer", "from": "mlc…", "to": "mlc…", "amount": 5, "nonce": 3,
 "timestamp": 1784067518.6, "public_key": "…", "signature": "…"}
```

- `credit` — treasury → address (faucet, rewards); only valid from treasury context
- `transfer` — address → address
- `stake` — locks amount for a `node_id`
- `unstake` — releases stake
- `slash` — burns from stake (consensus enforcement)

## Verification

Every block carries a **Merkle state root** over all account balances. Any client can:

```bash
curl "https://noeticompute.com/api/wallet/proof?address=mlc…"   # SPV Merkle proof
python3 launch.py sync --hub https://noeticompute.com --light   # verify headers
python3 launch.py sync --hub https://noeticompute.com           # full replay
```

A full sync rebuilds state from genesis transaction-by-transaction and rejects any
chain whose state roots don't match.

## Wallets

- **CLI:** `python3 wallet_cli.py create|balance|transfer|stake` — stored in
  `connection-layer/data/wallets/` (chmod 600)
- **App (PC / Android):** `@noble/ed25519` in the browser, keys in local storage on
  *your* device — never sent to any server
- Address format: `mlc` + first 42 hex chars of Ed25519 public key
