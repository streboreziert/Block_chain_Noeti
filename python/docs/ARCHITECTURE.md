# Noetis — Complete Architecture

Decentralized AI inference network with its own blockchain (Proof-of-Inference), its own
currency (MLC), privacy routing, and end-to-end encryption. This document is the master
plan and structure of the whole system.

---

## 1. The big picture

```
                         DISCOVERY (website — entry point only)
                     https://noeticompute.com  ·  /entry.txt
                 IPs · access points · validator public keys
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   USER APP                    RELAY NODES                COMPUTE NODES
 (Android PWA /              (privacy layer,             (Ollama + stake,
  laptop / PC,                strips identity)            E2E encrypted
  local wallet)                     │                     tasks, attested)
        │                           │                           │
        └───────────► HUB(S) ◄──────┴───────────────────────────┘
                 federation of validators
                 consensus · settlement · gossip mesh
                            │
                            ▼
                 PROOF-OF-INFERENCE BLOCKCHAIN
              MLC currency · Merkle state roots ·
              Ed25519 validator signatures · cosign quorum
```

**Task flow:** `user → entry → relay → compute → consensus → block → MLC reward`

Chat clients can request **Fast** (finalize after 1 result) or **Verified** (majority up to 3),
plus always-on `[time context]`, optional live web facts (`[web context]` when Internet is on), and a per-request `max_tokens` / `num_predict` override.

The website is only a door. Everything that runs — apps, nodes, wallets — lives on
GitHub and on the participants' own machines.

---

## 2. Components

### 2.1 Website (discovery only)

| URL | Purpose |
|-----|---------|
| `/` | Pitch site — what the network is, how to join |
| `/entry.txt` | **Machine-readable live registry** — hub IPs/ports, mesh peers, online devices, validator public keys |
| `/entry` | Browser view of `entry.txt` with copy button |
| `/join` | Human join guide with live commands |
| `/join.sh` | One-line installer script |
| `/mobile` | Installable PWA for Android / any browser (connects to hub API; wallet keys stay on the device) |
| `/api/*` | Hub API (blockchain, inference, wallet, federation) |

The website never holds user wallets or prompts. It publishes *where* the network is,
not *what* runs on it.

### 2.2 User app (Android / laptop / PC)

Two ways to run the same client (`client/`):

1. **Standalone (PC/Mac/Linux)** — `python3 launch.py user --hub URL --open`
   runs `user_app.py`, a tiny local Flask server on `127.0.0.1:5056`. Nothing user-side
   touches the public server except hub API calls.
2. **PWA (Android / any browser)** — open `https://noeticompute.com/mobile`, then
   "Add to Home Screen". Same client code, same local-storage wallet, offline-capable
   shell. Keys never leave the phone.

Client features: chat with the network, live mesh view, chain explorer, MLC transaction
log, Ed25519 wallet (create / faucet / stake), terminal log of everything the app does.

### 2.3 Relay nodes (privacy layer)

`python3 launch.py relay --hub URL --id my-relay`

Relays poll the hub for pending tasks and forward them to the compute pool. Compute
nodes never learn who asked; the hub logs only hashes. Anyone can run a relay — it is
the "third party" that breaks the user↔compute link.

### 2.4 Compute nodes (the miners)

`python3 launch.py compute --hub URL --id my-gpu`

Requirements: Ollama + a staked wallet (10 MLC minimum).
Every task arrives **E2E encrypted** (X25519 + AES-256-GCM) — only the assigned
compute node can decrypt the prompt. Results are returned encrypted and carry a
signed **model attestation** (which model, hash of output, timing) from the node's
Ed25519 key. Matching consensus earns MLC; deviating from consensus gets slashed.

### 2.5 Hub / validators (federation)

Each hub runs the full stack: entry API, task dispatch, consensus, chain, mesh.
Hubs federate: they register each other's validator keys, cosign every block
(quorum = 2 with two hubs), and share one canonical chain (longest-valid-chain,
primary is tie-breaker at genesis). Gossip mesh (TCP :5053/:5054) propagates blocks;
HTTP `/api/chain/sync` handles catch-up.

### 2.6 Blockchain (Proof-of-Inference, chain v4)

- **Block =** inference task settlement: prompt *hash* (never the prompt), consensus
  result hash, worker Merkle root, MLC transactions, Merkle **state root** of all
  account balances, validator signature + federation cosignatures.
- **State =** rebuilt deterministically from transactions; any peer can verify.
- **Light clients** sync headers only and verify balances with **SPV Merkle proofs**
  (`/api/wallet/proof`).

### 2.7 MLC currency

See `docs/TOKENOMICS.md`. Short version: 1,000,000 MLC genesis treasury; earned by
verified inference; 10 MLC stake to provide compute; slashing for bad results;
rate-limited faucet (50 MLC / wallet / 24 h) for onboarding.

---

## 3. Repository structure

```
Block_chain_Noeti/python
├── Launch.command            # double-click menu (macOS)
├── join.sh                   # one-line installer (curl | bash)
├── launch.py                 # role launcher: hub/user/relay/compute/sync/mesh
├── app.py                    # hub server (Flask + gunicorn)
├── user_app.py               # standalone local user app
├── compute.py / relay.py     # node clients
├── sync_node.py              # full / light chain sync
├── wallet_cli.py             # wallet create/faucet/stake/transfer
├── federation_cli.py         # hub federation join / sync-chains
├── security_check.py         # security audit script
├── client/                   # user app UI (PWA-capable)
│   ├── app.html  manifest.json  sw.js
│   └── static/   app.js  wallet.js  app.css  logo.svg
├── html/                     # website (discovery only)
├── connection-layer/         # core: chain, wallet, consensus, mesh, crypto
│   ├── inference_chain.py    # blocks, Merkle roots, sealing
│   ├── chain_state.py        # balances, stake, mempool, tx validation
│   ├── crypto_wallet.py      # Ed25519 wallets
│   ├── task_crypto.py        # X25519 + AES-GCM task encryption
│   ├── attestation.py        # signed model attestations
│   ├── consensus.py          # cosignature quorum
│   ├── validators.py         # federation registry
│   ├── gossip_mesh.py        # TCP mesh + mDNS
│   ├── p2p_sync.py  spv.py   # sync + SPV proofs
│   └── network_hub.py        # dispatch, relays, compute registry
├── docs/                     # this documentation set
├── Dockerfile  docker-compose.prod.yml  docker-compose.peer.yml
└── deploy.sh  federation-setup.sh
```

---

## 4. Network protocol summary

| Channel | Transport | Content |
|---------|-----------|---------|
| User → hub | HTTPS `/api/infer` | prompt (TLS), hub stores only hash |
| Hub → compute | HTTPS poll, payload E2E encrypted | X25519 ephemeral + AES-GCM |
| Compute → hub | HTTPS, encrypted response + attestation | signed result |
| Hub ↔ hub | HTTPS `/api/chain/*` + TCP gossip :5053 | blocks, cosignatures |
| Anyone | HTTPS `/entry.txt`, `/api/chain/headers` | discovery, light sync |

---

## 5. Trust model

- **Validators** are the trust anchors; their public keys are published on `/entry.txt`.
  Blocks need a validator signature and a cosignature quorum.
- **Compute** is untrusted: results must match consensus across nodes, are attested, and
  stake is slashed for outliers.
- **Relays** are untrusted for content (they only see encrypted payload envelopes) but
  trusted to forward — multiple relays remove single points.
- **Users** are anonymous: identified only by wallet address, never by prompt content
  on-chain.

Full details: `docs/SECURITY.md` and `docs/PRIVACY.md`.

---

## 6. Roadmap (honest state)

| Stage | Status |
|-------|--------|
| Single hub + chain + MLC | ✅ live (noeticompute.com) |
| Federation (2 validators, cosign quorum 2) | ✅ live (same host; second physical host = next step) |
| E2E task encryption + attestation | ✅ |
| Light client + SPV proofs | ✅ |
| Android via PWA | ✅ `/mobile` |
| Deterministic proposer schedule + fork resolution | ✅ round-robin by height over sorted validator keys |
| Finality checkpoint (bounded reorg depth) | ✅ `MAX_REORG_DEPTH`, no silent genesis regeneration |
| On-chain validator set (stake-backed) | ✅ `validator_register` tx, 100 MLC stake |
| SQLite storage + incremental state | ✅ O(1) appends, cached state/validity |
| Deterministic inference (temp 0, seed 42) | ✅ enforced in Ollama client, recorded in proof |
| Second physical server + HTTPS peer domain | ⏳ needs DNS `peer.noeticompute.com` |
| Native Android APK (wrap PWA) | ⏳ optional (TWA wrapper) |
| BFT voting rounds (vs. schedule + tiebreak) | ⏳ future — current scheme resolves forks but isn't pipelined BFT |
| zkML / TEE inference proofs | ❌ hardest open problem; determinism is the interim mitigation |
