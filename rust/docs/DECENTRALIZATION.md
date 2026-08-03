> Python hub (`BLOCKCHAIN_Noetis`) is the primary implementation. This Rust tree mirrors critical decentralization bits (gossip `TASK_FINALIZED`, hub-blind browser keys, status `decentralization`).

# Decentralization path — Noeti Compute Lab

Goal: **website = human entry + observer + always-on site compute**. **Peers = growing network brain** (tasks, consensus, chain, settlement).

## Honest status (0.5.35)

**What this is:** **2-validator federated hub (same host); ready for 2nd machine.**

Not “100% decentralized.” The peer validator currently shares the same VPS as the primary entry hub. Cosign quorum is real (`COSIGN_QUORUM=2`), mesh gossip + hub-blind hashing are real, browser X25519 is real — but one operator / one host still controls both validators until peer compose moves to a second machine.

| Shipped now | Still lacking |
|-------------|----------------|
| Dual validator cosign (same host, 2 containers) | Second physical operator / home NAT mesh |
| `MESH_CONSENSUS=1` — verified/earn needs ≥2 node results | Fully hubless money / stake settlement on mesh alone |
| Hub-blind + browser X25519 (no plaintext exception when keys present) | Many independent validators |
| `/entry.txt` bootstrap lists primary + peer (`role=bootstrap`) | Client always talking to a local node only |
| Status `decentralization: { validators, cosign_quorum, mesh_consensus, hub_blind, faucet }` | No single-site authority for chain tip |

**Second machine later:** move `docker-compose.peer.yml` + `.env.federation.peer` to host B; point `FEDERATION_PEERS` / DNS; keep Redis on primary or run peer Redis. See `federation-setup.sh` footer notes.

## Done in this slice (0.5.35)

- **Production dual hub (same machine)** — primary `docker-compose.prod.yml` + peer `docker-compose.peer.yml`; `COSIGN_QUORUM=2`; both join each other; peer Redis on shared `noetis-redis` DB 1.
- **Mesh consensus path** — when ≥2 results share a response hash and gossip `TASK_RESULT` is seen (or `MESH_CONSENSUS=1`), prefer finalize from hash agreement. Verified/earn requires ≥2 distinct node results when ≥2 online; **chat fast mode stays quorum=1** for UX. Broadcast `TASK_FINALIZED` on gossip.
- **Browser X25519** — `browser_compute.js` generates/stores keys, registers `enc_pubkey`, decrypts prompts, encrypts responses; hub removes browser plaintext exception when keys present.
- **Entry framing** — `/entry.txt` + discovery: primary + peer URLs, `role=bootstrap`. Homepage/docs: entry point; validators on mesh. Observer shows both validators.

## Done in this slice (0.5.33)

- **Wikipedia-first World Cup grounding** — schedule/hosts/teams intents always fetch the canonical Wikipedia REST summary (`2026_FIFA_World_Cup`) first, labeled as `Source: Wikipedia — …`. Sporting News / score scrapes only for live score questions.
- **Preamble grounding** — when `[web context]` is present, answer ONLY from it; never invent hosts, team counts, or dates; if empty, say verified live data is unavailable (no training-memory sports guesses).

## Done in this slice (0.5.32)

- **Stronger live web fetch** — sports/news intents rewrite to searchable queries; backends: DDG Instant Answer, DDG HTML lite (skip captcha), Wikipedia search+summary, Wikidata, and score-rich sports pages. Prefers snippets with scores/dates. On total failure: inject `(No live results retrieved.)` and `web_ok=false`.
- **Authoritative time context** — hub always injects `[time context]` (UTC date/time, hub timezone) before scoring/hashing so weekday/date answers stay correct offline.
- **Legit web fetch** — Internet mode uses DuckDuckGo Instant Answer JSON + Wikipedia summaries; captcha/challenge pages are failures (`web_ok=false`), never stripped into prompt context.

## Phases

| Phase | Deliverable | Hub role |
|-------|-------------|----------|
| 1 | Task IDs + concurrent infer | Hub still coordinates |
| 2 | Desktop/local node as client API | Hub = bootstrap + fallback |
| 3 | Gossip `TASK_*` publish/claim/result | Hub optional for chat/earn |
| 4 | Stake / balances / blocks on mesh validators | Hub gone for money |
| 5 | Website entry-only + multi-source bootstrap | No hub dependency |

## Done in this slice (0.5.24) — shipped interim

- **Faucet OFF by default** — `ALLOW_FAUCET` defaults to `"0"`; prod compose sets `ALLOW_FAUCET=0`. Observer `faucet_enabled` shows off. Local `docker-compose.yml` may set `ALLOW_FAUCET=limited` for onboarding. **site-01** still funds/stakes via **internal treasury credit** in `ensure_site_compute` (not the public `/api/faucet`).
- **Peer claim without hub poll (mesh-first)** — gossip `pending_offers` mailbox + `open_offers()`; hub `list_open_offers` / `claim_task` / `_assign_task`; `GET /api/compute/offers`, `POST /api/compute/claim`. Desktop `compute.py`, site-01 loop, and `browser_compute.js` try offers→claim before `poll_task` (poll remains fallback).
- **Hub-blind consensus (Option B interim)** — `HUB_BLIND=1` default (prod compose). Ollama/desktop must register `enc_pubkey`; assign encrypts task and wipes `task.prompt` (hold only for further assigns). `submit_result` majority on **response hashes**; finalize decrypts **only the winner** for chat `consensus_response`. `get_task` never returns plaintext prompt. site-01 generates X25519 keys at `ensure_site_compute`.

## Prior (0.5.23)

- **Site compute (`site-01`)** — when Ollama is available, the entry hub auto-registers a persistent site wallet (`data/site_wallet.json`), stakes ≥ `MIN_STAKE`, and heartbeats/polls as **coordinator+compute** that earns real MLC (replaces synthetic `local-01..03`).
- **Prompt complexity → model routing** — `score_prompt` estimates tokens + complexity tier (`tiny|small|medium|large`); tasks prefer matching Ollama model sizes; site-01 remains the eligible fallback. Snapshot exposes `last_route` / `route_history`.
- **Coordinators grow with the network** — `site-01` always; other online staked ollama nodes join via heartbeats / `coordinator: true` / top-K stake. Snapshot: `coordinators`, per-node `roles` + `capability_tier`.
- **Observer / network watch** at `/observer` (`#site`) — site node, token/complexity routing, coordinators, capability map, plus existing flows graph.

## Prior (0.5.22)

- Observer flows + gossip `TASK_OFFER` / `TASK_CLAIM` / `TASK_RESULT` (Python + Rust).
- Discovery hooks — `/entry.txt` + `/api/discovery`.
- Faucet — `ALLOW_FAUCET`; mainnet path `ALLOW_FAUCET=0`.

## Next (honest gaps)

- Move peer validator to a second physical machine / independent operator.
- Chain + MLC settlement default on mesh; no single-site authority.
- NAT / relay so home nodes discover each other without the website.
- Client always talks to local node; website never required for live chat.

## Env

| Variable | Purpose |
|----------|---------|
| `SITE_COMPUTE_ID` | Site node id (default `site-01`) |
| `OLLAMA_HOST` | Ollama base URL (default `http://127.0.0.1:11434`; prod compose uses `http://ollama:11434`) |
| `COORDINATOR_HEARTBEATS` | Heartbeats before a staked node may become coordinator (default `10`) |
| `BOOTSTRAP_PEERS` | Comma-separated hub/peer URLs merged into discovery + mesh federation |
| `ALLOW_FAUCET` | `0`/`false` disables faucet (default). `limited` for local onboarding |
| `HUB_BLIND` | `1` (default) — require enc_pubkey; wipe prompt after encrypt; hash majority |
| `MESH_CONSENSUS` | `1` — verified/earn needs ≥2 node results; chat fast stays quorum=1 |
| `COSIGN_QUORUM` | Block cosignatures required (prod dual-hub: `2`) |
| `PUBLIC_URL` | Public entry URL advertised in discovery |
| `MESH_PORT` | Gossip TCP port (default 5053; peer uses 5054) |

## Open observer

- Local hub: `http://127.0.0.1:5052/observer` (deep-link `#site`)
- Production: `https://noeticompute.com/observer`
