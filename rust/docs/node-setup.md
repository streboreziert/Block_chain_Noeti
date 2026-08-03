# Node Setup Guide

## Prerequisites

- [Ollama](https://ollama.com) installed and running
- At least one model pulled, e.g. `ollama pull llama3.2:3b`
- Network access to the coordinator WebSocket URL

## Linux / macOS

```bash
git clone https://github.com/streboreziert/Block_chain_Noeti.git
cd Block_chain_Noeti/rust
npm install
npm run build -w @noetis/node

# Start node
node services/node/dist/cli.js start \
  --coordinator wss://YOUR-COORDINATOR/ws \
  --wallet ./node-data/wallet.json \
  --ollama http://localhost:11434
```

Or use the CLI after global link:

```bash
npm link -w @noetis/node
noetis-node start --coordinator wss://testnet.example.com/ws --wallet ./wallet.json --ollama http://localhost:11434
```

## Windows (PowerShell)

```powershell
git clone https://github.com/streboreziert/Block_chain_Noeti.git
cd Block_chain_Noeti/rust
npm install
npm run build -w @noetis/node

node services/node/dist/cli.js start `
  --coordinator wss://YOUR-COORDINATOR/ws `
  --wallet .\node-data\wallet.json `
  --ollama http://localhost:11434
```

## Docker (public test network)

```bash
docker run \
  -e NOETIS_COORDINATOR_URL=wss://testnet.example.com/ws \
  -e OLLAMA_URL=http://host.docker.internal:11434 \
  -v ./node-data:/app/data \
  noetis/node:latest
```

On Linux, add `--add-host=host.docker.internal:host-gateway` if needed.

## Configuration options

| Flag | Env var | Default |
|------|---------|---------|
| `--coordinator` | `NOETIS_COORDINATOR_URL` | `ws://localhost:3002/ws` |
| `--wallet` | `NOETIS_WALLET_PATH` | `./data/wallet.json` |
| `--ollama` | `OLLAMA_URL` | `http://localhost:11434` |
| `--input-price` | — | `0.00001` |
| `--output-price` | — | `0.00003` |
| `--max-tasks` | — | `2` |
| `--models` | — | all installed models |

## Node behavior

1. Connects to coordinator (auto-reconnect on disconnect)
2. Registers public key, Ollama models, hardware info
3. Sends heartbeats every 15 seconds
4. Accepts encrypted tasks, runs Ollama inference (temperature=0, fixed seed)
5. Returns signed result hash and response
6. Earns NOET after validator verification

## Security notes

- Prompts are passed **only as data** to Ollama — never executed as shell commands
- Store wallet files securely; they control your node identity and earnings
- Prototype uses test NOET with no real value
