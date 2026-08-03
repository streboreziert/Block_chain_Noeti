# Network setup for friends

How to run a **host node** and let friends connect compute/full nodes securely over the internet.

## Architecture (hybrid)

| Role | What runs | Required for friends |
|------|-----------|----------------------|
| **Network host** (you) | Postgres, Redis, API, Coordinator, seed full-node | Yes — one shared stack |
| **Friend full-node** | `noetis-full-node` validator | Optional (chain sync) |
| **Friend compute node** | `noetis-node` + Ollama | Yes (to process tasks) |
| **Friend user** | Web dashboard or API client | Optional |

Task prompts are **encrypted** (NaCl box) and delivered via the coordinator WebSocket. Chain state syncs over **P2P gossip** (signed messages).

---

## Ports to open (host machine)

Forward these on your router/firewall to the host running the network:

| Port | Protocol | Service |
|------|----------|---------|
| **4001** | TCP | P2P gossip (full-node bootstrap) |
| **4000** | TCP | Full-node HTTP API (optional, queries) |
| **3002** | TCP | Coordinator WebSocket (`/ws`) — **required for compute nodes** |
| **3001** | TCP | REST API — **required for users/wallets/tasks** |
| **3000** | TCP | Web dashboard (optional) |

Friends' compute nodes only need **outbound** access to your host. They run Ollama locally on **11434** (not exposed).

### Linux firewall example (host)

```bash
sudo ufw allow 4001/tcp
sudo ufw allow 4000/tcp
sudo ufw allow 3001/tcp
sudo ufw allow 3002/tcp
sudo ufw allow 3000/tcp
sudo ufw enable
```

---

## 1. Start the network (host)

Replace `YOUR_PUBLIC_IP` with your public IP or DNS name.

```bash
git clone https://github.com/streboreziert/Block_chain_Noeti.git
cd Block_chain_Noeti/rust

export PUBLIC_HOST=YOUR_PUBLIC_IP
export NOETIS_PUBLIC_HOST=$PUBLIC_HOST
export INTERNAL_DISPATCH_TOKEN=$(openssl rand -hex 32)  # optional but recommended

docker compose up -d postgres redis fullnode1 api coordinator validator web
node packages/database/dist/migrate.js
```

Or without Docker (macOS/Homebrew):

```bash
./scripts/start-backend.sh          # terminal 1 — API + DB
npm run dev -w @noetis/coordinator  # terminal 2
npm run dev -w @noetis/validator    # terminal 3
npm run dev -w @noetis/full-node -- start --seed --validator --p2p-port 4001 --http-port 4000
npm run dev -w @noetis/web          # terminal 4
```

Set on the host:

```bash
export NOETIS_PUBLIC_HOST=YOUR_PUBLIC_IP
export INTERNAL_DISPATCH_TOKEN=your-shared-secret   # same value for api + coordinator
```

---

## 2. Share these URLs with friends

```
P2P bootstrap:   ws://YOUR_PUBLIC_IP:4001
Coordinator:     ws://YOUR_PUBLIC_IP:3002/ws
API:             http://YOUR_PUBLIC_IP:3001
Dashboard:       http://YOUR_PUBLIC_IP:3000
```

For production, put **nginx/Caddy** in front with TLS:

- `wss://your.domain/ws` → coordinator
- `https://your.domain/api` → API

---

## 3. Friend joins as compute node (Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/streboreziert/Block_chain_Noeti/main/rust/scripts/install-linux.sh | bash -s -- compute \
  --bootstrap ws://YOUR_PUBLIC_IP:4001 \
  --coordinator ws://YOUR_PUBLIC_IP:3002/ws \
  --p2p-port 4010 \
  --run
```

Requirements on friend machine:

- Node.js 20+
- [Ollama](https://ollama.com) with a model: `ollama pull llama3.2:3b`
- Outbound TCP to host ports 3002 and 4001

---

## 4. Friend joins as full validator (optional)

```bash
curl -fsSL https://raw.githubusercontent.com/streboreziert/Block_chain_Noeti/main/rust/scripts/install-linux.sh | bash -s -- full-node \
  --bootstrap ws://YOUR_PUBLIC_IP:4001 \
  --p2p-port 4002 \
  --http-port 4003 \
  --run
```

Use a **unique `--p2p-port`** per machine. Set `NOETIS_PUBLIC_HOST` to the friend's public IP so the mesh can dial back.

---

## Security checklist

- [ ] Set `INTERNAL_DISPATCH_TOKEN` on API and coordinator (blocks unauthorized task injection)
- [ ] Use TLS (`wss://` / `https://`) for public deployments
- [ ] Never share wallet `private_key` files
- [ ] Prompts are encrypted end-to-end to node `box_public_key`
- [ ] All P2P and WebSocket payloads are Ed25519 signed
- [ ] Test NOET only — no real monetary value

See [security.md](./security.md).

---

## Verify connectivity

**From friend machine:**

```bash
curl http://YOUR_PUBLIC_IP:3001/health
curl http://YOUR_PUBLIC_IP:4000/health
```

**On host dashboard:** `network` command should show online nodes > 0 after friends start `noetis-node`.

**Chain sync:** friend full-node logs should show `Synced chain to height N`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `API OFFLINE` in dashboard | Start `./scripts/start-backend.sh`, open port 3001 |
| Compute node connects but no tasks | Friend must use **your** `--coordinator` URL, not localhost |
| P2P sync fails | Open port 4001 on host; set `NOETIS_PUBLIC_HOST` |
| `401 Unauthorized internal dispatch` | Match `INTERNAL_DISPATCH_TOKEN` on api + coordinator |
| Remote dashboard calls localhost | Set `NEXT_PUBLIC_API_URL=http://YOUR_PUBLIC_IP:3001` when building web |
