# Decentralized Blockchain Guide

Noetis Compute now supports **real multi-node blockchain** with P2P gossip — no single central server required for chain truth after bootstrap.

## Architecture

```text
Friend A (fullnode1) ◄──P2P gossip──► Friend B (fullnode2)
        │                                      │
        └──────────► Friend C (fullnode3) ◄────┘
        
Each full node:
  • Stores full chain locally (chain.json)
  • Validates blocks with 2/3 validator quorum
  • Gossips transactions and blocks
  • Serves HTTP API for wallets/balances
  • Gossips task offers to processing nodes
```

## Run 3 validators locally

```bash
docker compose up fullnode1 fullnode2 fullnode3
```

Or manually:

```bash
# Terminal 1 — seed node
noetis-full-node start --data ./data/fn1 --p2p-port 4001 --http-port 4000 --validator

# Terminal 2 — friend joins
noetis-full-node start --data ./data/fn2 --p2p-port 4002 --http-port 4010 \
  --bootstrap ws://FRIEND_IP:4001 --validator

# Terminal 3 — another friend
noetis-full-node start --data ./data/fn3 --p2p-port 4003 --http-port 4020 \
  --bootstrap ws://FRIEND_IP:4001 --validator
```

## Friends connect (no central server)

Once any friend runs a full node with a public IP or tunnel:

```bash
# Run blockchain validator
noetis-full-node start \
  --bootstrap ws://friend.example.com:4001 \
  --validator \
  --p2p-port 4002 \
  --http-port 4000

# Run AI processing node
noetis-node start \
  --p2p-bootstrap ws://friend.example.com:4001 \
  --ollama http://localhost:11434
```

## Chain-verified balances

Query any full node:

```bash
curl http://localhost:4000/chain/balance/noet1...
curl http://localhost:4000/chain
curl http://localhost:4000/peers
```

Submit transaction to mempool (gossiped to all validators):

```bash
curl -X POST http://localhost:4000/tx -H 'Content-Type: application/json' -d '{...}'
```

## Consensus

- **Multi-validator BFT**: blocks need 2/3 validator signatures
- **Round-robin proposer**: rotates each block
- **PoS interface**: `StakeRegistry` for delegated validators (prototype stake: 100 NOET)
- **Local chain storage**: each node keeps `chain.json` — not dependent on central PostgreSQL

## Hybrid mode

The API still supports coordinator-based task routing as fallback. New flow:

1. User submits task via API
2. API gossips `TASK_OFFER` to P2P network
3. Processing nodes receive offer via gossip
4. Encrypted payload delivered via coordinator (being migrated to full P2P)
5. Settlement transactions gossiped to validators → included in blocks

## What's still centralized (temporary)

- PostgreSQL task index (optional convenience)
- Coordinator WebSocket for encrypted prompt delivery
- Dev faucet

These can be removed as P2P task encryption matures.
