# Noetis Compute

**A decentralized AI network.** Share compute, earn **MLC**, chat with the mesh — no sign-up.

## Monorepo layout

| Path | What it is |
|------|------------|
| [`rust/`](.) *(you are here)* | **Rust product** — apps, hub, compute, wallet, installers |
| [`python/`](../python) | Live Python network at [noeticompute.com](https://noeticompute.com) |

Wire-compatible: Rust and Python nodes share the same chain, signatures, and MLC.

```bash
git clone https://github.com/streboreziert/Block_chain_Noeti.git
cd Block_chain_Noeti/rust
```

---

## Download & run (users)

### One-line install

```bash
# macOS / Linux
curl -sSL https://noeticompute.com/install.sh | bash

# Windows PowerShell
irm https://noeticompute.com/install.ps1 | iex
```

Or grab a release from **[GitHub Releases](https://github.com/streboreziert/Block_chain_Noeti/releases)** /
`/download` on a running hub.

| Platform | What you get |
|----------|----------------|
| **macOS** | `noetis-app` + `Noetis.app` launcher |
| **Linux** | binaries + `.desktop` launcher |
| **Windows** | `noetis-app.exe` + Start Menu shortcut |
| **Android** | Open `/mobile` → browser menu → **Add to Home Screen** (PWA) |

On first launch the app **creates your MLC wallet** and claims faucet credit automatically.
Backup / restore / transfer / stake are in the Wallet tab.

```bash
noetis-app --hub https://noeticompute.com          # chat + wallet UI
noetis-compute --hub https://noeticompute.com --id my-node   # earn (needs Ollama)
noetis-wallet create && noetis-wallet show --hub https://noeticompute.com
```

---

## Build from source

```bash
cargo build --release -p noetis-network

./target/release/noetis-app --hub https://noeticompute.com
./target/release/noetis-hub --port 5052
./target/release/noetis-sync --hub https://noeticompute.com --once
```

Release binaries are packed by `.github/workflows/release.yml` on version tags (`v*`).

### Binaries

| Binary | Role |
|--------|------|
| `noetis-app` | User app (chat, wallet, PWA assets) |
| `noetis-hub` | Full hub API + `/app` + `/download` + installers |
| `noetis-compute` | Ollama compute node |
| `noetis-relay` | Anonymous relay |
| `noetis-sync` | Full / light chain verifier |
| `noetis-wallet` | CLI wallet |

### Crates

- `crates/noetis-chain` — protocol core (JSON, MLC state, SPV, crypto)
- `crates/noetis-network` — HTTP hub, gossip, nodes, embedded client UI

Legacy crates under `apps/` / older `noetis-*` are the earlier NOET prototype — not the live MLC network.

## License

MIT
