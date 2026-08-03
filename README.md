# Noetis Blockchain

**Decentralized AI compute mesh.** Share spare compute, earn **MLC**, chat with the network — no company in the middle, no sign-up.

Live network: **[noeticompute.com](https://noeticompute.com)**

---

## What's in this repo

| Path | Stack | Role |
|------|--------|------|
| [`python/`](./python) | Python / Flask | **Live network** — hub, compute, relay, wallet, site |
| [`rust/`](./rust) | Rust (Cargo workspace) | High-performance port — same chain, signatures, MLC |

Both stacks speak the same wire protocol. Run either; they interoperate.

```
Block_chain_Noeti/
├── python/          # production mesh (noeticompute.com)
│   ├── app.py       # hub API
│   ├── compute.py   # earn by running AI jobs
│   ├── wallet_cli.py
│   ├── html/        # web + PWA UI
│   └── docs/
├── rust/            # Rust rewrite
│   ├── crates/      # chain, network, crypto, p2p, …
│   ├── Cargo.toml
│   └── docs/
├── .github/         # release builds for Rust binaries
└── LICENSE          # MIT
```

---

## Quick start

### Just use the network

```bash
# Join via the live hub (macOS / Linux)
curl -sSL https://noeticompute.com/join.sh | bash
```

Or open **[noeticompute.com](https://noeticompute.com)** / **[/mobile](https://noeticompute.com/mobile)** on your phone → Add to Home Screen.

### Run the Python hub locally

```bash
cd python
cp ../.env.example .env   # optional; fill secrets locally only
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 app.py
```

### Build the Rust stack

```bash
cd rust
cargo build --release -p noetis-network

./target/release/noetis-app --hub https://noeticompute.com
./target/release/noetis-hub --port 5052
./target/release/noetis-compute --hub https://noeticompute.com --id my-node
```

Release binaries ship on version tags (`v*`) via GitHub Actions.

---

## Earn MLC

Providers lock a small **MLC deposit**, run [Ollama](https://ollama.com), and get paid when they complete AI work for the mesh.

```bash
ollama serve && ollama pull qwen2.5:0.5b

# Python path
cd python
python3 wallet_cli.py create
python3 wallet_cli.py stake --hub https://noeticompute.com --node-id my-gpu
python3 launch.py compute --hub https://noeticompute.com --id my-gpu
```

---

## Docs

- Python: [`python/docs/`](./python/docs) — architecture, security, tokenomics, join guide
- Rust: [`rust/docs/`](./rust/docs) + [`rust/README.md`](./rust/README.md)
- Whitepaper: [`python/docs/whitepaper/`](./python/docs/whitepaper)

---

## License

[MIT](./LICENSE)
