# Privacy design

Goal: **nobody in the network learns both who you are and what you asked.**

---

## Layers of privacy

### 1. Relay routing — identity separation

```
User ──► Hub (accepts task) ──► Relay (forwards) ──► Compute pool
```

- Users never connect to compute nodes; compute polls the hub for anonymous tasks.
- Relays are third parties: they mark tasks ready for compute without seeing user
  identity (the hub strips it before the task is queued).
- With no external relay online, the hub auto-relays — same anonymity property, one
  fewer party.

### 2. Hash-only chain — content never stored

The blockchain stores **only hashes**:

- `prompt_hash` = SHA-256 of the prompt
- `response_hash` = SHA-256 of the consensus response
- Merkle root of worker results

The prompt/response text lives only in RAM during the task and in the user's own app.
Anyone can *verify* a task happened (hash matches) without ever learning its content.

### 3. End-to-end encryption — compute-only decryption

Hub → compute task payloads are encrypted per node:

- Each compute node generates an **X25519** keypair on first run (stored locally,
  chmod 600) and registers only the public key.
- The hub encrypts the prompt with an ephemeral X25519 key + **AES-256-GCM**
  (HKDF-SHA256 derived key). Only the assigned node can decrypt.
- Responses go back encrypted to the hub's ephemeral key.

So a passive observer of hub↔compute traffic sees ciphertext; other compute nodes see
nothing that isn't theirs.

### 4. Wallet pseudonymity

- Identity on-chain = `mlc…` address (hash of a public key you generated locally).
- No email, no account, no KYC. The faucet rate-limits per address + IP, nothing more.
- App wallet keys live in device local storage / local files; the network only ever
  sees signatures.

### 5. What each party can see

| Party | Sees | Does NOT see |
|-------|------|--------------|
| Website | your IP hitting `/entry.txt` | wallet, prompts |
| Hub (HUB_BLIND=1) | prompt briefly until encrypted to assignees; response **hashes** for majority; decrypts **winner only** for chat | prompt on disk/chain; peer response plaintexts after finalize; `get_task` never returns prompt |
| Hub (HUB_BLIND=0 / browser exception) | prompt in RAM for assign + classic majority | prompt on disk/chain (hash only) |
| Relay | task envelope (id + routing) | prompt content, user identity |
| Compute (ollama/desktop) | decrypted prompt of its own tasks | who asked (no user identity attached) |
| Compute (browser, interim) | plaintext prompt until JS X25519 lands | who asked |
| Chain (public) | hashes, MLC transactions, attestation signatures | any prompt or response text |

### Known limits (be honest)

- **Internet toggle** — when off, the hub still injects `[time context]` only; no outbound web fetch. When on, the hub may query Instant Answer / DDG HTML / Wikipedia / Wikidata / sports pages for shared `[web context]` (no captcha HTML).

- With **HUB_BLIND=1**, the hub still holds plaintext briefly to encrypt per assignee
  (`_prompt_hold`), then wipes after finalize. Consensus is on response hashes; only the
  winning response is decrypted for the user. A malicious hub operator could still log
  during that window. Longer-term: mesh validators + TEE / secure aggregation.
- **Browser earn** may still receive plaintext prompts under the interim exception
  (see `docs/DECENTRALIZATION.md`).
- IP addresses are visible to whichever endpoint you connect to — use a VPN/Tor if IP
  privacy matters.
- MLC flows are public (like Bitcoin). Don't reuse an address if unlinkability matters.
- Public faucet is **off by default** (`ALLOW_FAUCET=0`); site bootstrap uses internal
  treasury credit, not `/api/faucet`.
