# Joining Noetis — every role, step by step

The website (https://noeticompute.com) is an **entry point / bootstrap** — not the
network brain. Validators cosign on the mesh; `/entry.txt` lists primary + peer
bootstrap URLs. Everything productive runs from GitHub code on your own machine.

---

## Fastest ways in

### One line (Mac / Linux)

```bash
curl -sSL https://noeticompute.com/join.sh | bash
```

Clones the repo, installs dependencies, opens the role menu.

### Android / any phone

1. Open **https://noeticompute.com/mobile** in Chrome/Safari
2. Menu → **Add to Home Screen**
3. Open the installed app → create a wallet → **Onboard 50 MLC** → chat, or tap **Earn** for browser compute (keep the tab open; experimental)

Your wallet keys are generated on the phone and never leave it. Phone Earn runs in the browser — leave that tab open while earning.

### Mac double-click

Clone the repo, then double-click `Launch.command` → pick a role (1–8).

---

## Role guide

### User (chat with the network) — PC/laptop

```bash
git clone https://github.com/streboreziert/Block_chain_Noeti.git
cd Block_chain_Noeti/python
pip3 install -r requirements.txt
python3 launch.py user --hub https://noeticompute.com --open
```

Opens the standalone app at `http://127.0.0.1:5056` — chat, wallet, chain explorer,
terminal log. No account, no signup: create a wallet in the Wallet tab.

### Compute provider (earn MLC)

Requirements: [Ollama](https://ollama.com) + ~1 GB model.

```bash
ollama serve
ollama pull qwen2.5:0.5b

python3 wallet_cli.py create
curl -X POST https://noeticompute.com/api/faucet \
  -H 'Content-Type: application/json' -d '{"address":"YOUR_MLC_ADDRESS"}'
python3 wallet_cli.py stake --hub https://noeticompute.com --node-id my-gpu
python3 launch.py compute --hub https://noeticompute.com --id my-gpu
```

What happens: your node registers (stake checked on-chain), then polls for E2E
encrypted tasks, runs them in Ollama, returns attested results. Consensus match =
MLC reward on-chain.

### Relay (strengthen privacy)

```bash
python3 launch.py relay --hub https://noeticompute.com --id my-relay
```

No stake needed. You forward anonymous tasks so compute never sees users.

### Chain verifier (keep everyone honest)

```bash
python3 launch.py sync --hub https://noeticompute.com          # full replay
python3 launch.py sync --hub https://noeticompute.com --light  # headers + SPV
python3 launch.py mesh --hub https://noeticompute.com          # gossip node
```

### Host your own hub / join the federation

```bash
python3 launch.py hub --public-url https://your-domain.com --open
python3 federation_cli.py join --peer https://noeticompute.com --public-url https://your-domain.com
```

For a production two-hub deployment see `federation-setup.sh`.

---

## Finding the network

Everything you need to connect is published live at:

```
https://noeticompute.com/entry.txt
```

— hub URLs and IPs, API/mesh ports, online devices (compute/relays with their access
points), and validator public keys to verify blocks against.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Ollama not running` | `ollama serve` then `ollama pull qwen2.5:0.5b` |
| `Need 10 MLC staked` | faucet + `wallet_cli.py stake` (see compute steps) |
| Faucet says already claimed | 1 claim per wallet per 24 h — wait or transfer MLC |
| App can't reach hub | check `https://noeticompute.com/api/health`; corporate proxies may block |
| Port 5056 busy | `python3 launch.py user --hub … --app-port 5057` |
