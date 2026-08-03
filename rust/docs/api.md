# API Reference

Base URL: `http://localhost:3001` (local) or your deployed API host.

## POST /api/wallets

Create a new Ed25519 wallet.

**Response:**
```json
{
  "address": "noet1...",
  "public_key": "...",
  "private_key": "...",
  "note": "Store private_key securely."
}
```

## POST /api/faucet

Request development test NOET.

**Body:** `{ "address": "noet1..." }`

**Warning:** Development only. 1000 NOET per claim, 1-minute cooldown.

## POST /api/tasks

Submit an AI task. Requires wallet signature over `{ wallet_address, timestamp, nonce }`.

**Body:**
```json
{
  "wallet_address": "noet1...",
  "prompt": "Your prompt",
  "model": "llama3.2:3b",
  "max_output_tokens": 512,
  "verification_level": "low",
  "processing_mode": "single",
  "signature": "base64...",
  "timestamp": 1783745000000,
  "nonce": "uuid"
}
```

## GET /api/tasks/:taskId

Returns task record with progress events.

## GET /api/network/stats

Network overview: nodes, tasks, supply, block height.
