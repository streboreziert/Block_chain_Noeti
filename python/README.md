# Noetis — a shared AI network that anyone can join

Noetis lets people around the world **share their computers to run AI**, and get
paid for it. You can use it to chat with an AI, or you can let your computer do AI
work for others and earn a digital coin called **MLC**.

There's no company in the middle. No sign-up, no email, no password. The network is
run by the people who use it.

**Try it now:** [noeticompute.com](https://noeticompute.com)

> **Python stack — the live network.** Flask hub, compute, relay, wallet, docs, and
> website. This is what runs at [noeticompute.com](https://noeticompute.com) today.
>
> The Rust port lives in [`../rust`](../rust). Clone the whole monorepo:
> `git clone https://github.com/streboreziert/Block_chain_Noeti.git`

---

## What can I actually do here?

Pick whichever sounds like you:

- **"I just want to chat with an AI."** → Open the app and start typing. (See *Just use it* below.)
- **"I have a decent computer and want to earn."** → Let your machine run AI tasks for others and get paid in MLC. (See *Earn by sharing your computer*.)
- **"I want to understand how it works / build on it."** → Jump to *How it works* and the [documentation](#documentation).

---

## Just use it (no setup)

### On your phone
1. Open **[noeticompute.com/mobile](https://noeticompute.com/mobile)** in your browser.
2. Tap your browser menu → **"Add to Home Screen."**
3. Open the app, tap **Create Wallet**, then **Get 50 MLC**.
4. **Chat** the network, or tap **Earn** to share browser compute (keep the tab open; experimental).

Your wallet (your MLC account) is created and stored **on your phone only**. Nobody
else can see it. Phone Earn needs the tab open while you are earning.

### On a computer
Open a terminal and paste this one line:

```bash
curl -sSL https://noeticompute.com/join.sh | bash
```

It downloads everything, then opens the app on your own machine. On a Mac you can
instead download the project and double-click **`Launch.command`**.

---

## Earn by sharing your computer

If you have a computer that can run [Ollama](https://ollama.com) (free AI software),
you can join as a **compute provider** and earn MLC whenever your machine helps
answer a request.

```bash
# 1. Install Ollama and download a small AI model
ollama serve
ollama pull qwen2.5:0.5b

# 2. Get the Noetis code
curl -sSL https://noeticompute.com/join.sh | bash

# 3. Create a wallet, get some starter MLC, lock a deposit, and go online
python3 wallet_cli.py create
python3 wallet_cli.py stake --hub https://noeticompute.com --node-id my-gpu
python3 launch.py compute --hub https://noeticompute.com --id my-gpu
```

**Why the deposit?** Providers lock 10 MLC as a good-behavior deposit. Do honest
work and you earn more; try to cheat and you lose part of the deposit. This keeps
the network trustworthy without anyone policing it.

---

## How it works (in plain words)

```
You ask a question  →  it's passed through a relay (which hides who you are)
                    →  several computers answer it independently
                    →  the network compares answers and agrees on the correct one
                    →  the result is recorded, and the helpers get paid in MLC
```

### Chat spend: Fast vs Verified

In the app **Settings** (or `settings mode …` in the terminal):

- **Fast** — finalize after **1** worker result (quorum=1). Lower latency / spend; still routes to a capable node.
- **Verified** — majority consensus (up to **3** online workers). Stronger agreement before you see the answer.

Optional **Internet** fetches live web facts (DuckDuckGo Instant Answer / HTML snippets, Wikipedia, Wikidata, sports pages; captchas count as failure) as `[web context]`. The hub always injects `[time context]` (UTC) for every ask. **Max tokens** caps answer length for that request.

The important promises:

- **Your questions are private.** They're encrypted on the way to the computers that
  answer them, and they are **never stored** — only a fingerprint (a hash) is kept as
  proof the work happened.
- **Nobody learns who you are.** A relay in the middle strips your identity, so the
  computers answering see the question but not who asked.
- **Answers are checked, not trusted.** Several machines answer the same question and
  the network only accepts the answer they agree on. Cheaters get penalized.
- **The ledger is tamper-proof.** Every payment and balance is written into a
  blockchain that anyone can independently verify.

MLC is the network's own coin. It's earned by doing useful AI work — not by wasteful
"mining" like Bitcoin. Full details in [docs/TOKENOMICS.md](docs/TOKENOMICS.md).

---

## The different ways to take part

| I want to… | Run this | What it does |
|------------|----------|--------------|
| **Chat with the AI** | `python3 launch.py user --hub https://noeticompute.com --open` | Opens the app on your machine |
| **Earn by providing AI** | `python3 launch.py compute --hub … --id my-gpu` | Your computer answers requests for MLC |
| **Help keep it private** | `python3 launch.py relay --hub … --id my-relay` | Passes requests along while hiding identities |
| **Double-check the ledger** | `python3 launch.py sync --hub … --light` | Verifies the blockchain yourself |
| **Run your own hub** | `python3 launch.py hub --public-url https://you.com` | Host part of the network |

---

## Is it safe? Check it yourself

You don't have to take our word for anything. This command audits the live network —
blockchain integrity, signatures, balances, and more — and prints a pass/fail report:

```bash
python3 security_check.py --hub https://noeticompute.com
```

---

## Documentation

Start with whichever fits you:

| Guide | Read it if you want to… |
|-------|-------------------------|
| [docs/JOIN.md](docs/JOIN.md) | Follow step-by-step setup for any role (with troubleshooting) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Understand the whole system and how the pieces fit |
| [docs/TOKENOMICS.md](docs/TOKENOMICS.md) | Learn how the MLC coin works — supply, rewards, deposits |
| [docs/PRIVACY.md](docs/PRIVACY.md) | See exactly what stays private and what doesn't |
| [docs/SECURITY.md](docs/SECURITY.md) | Review the security design and how to audit it |
| [docs/API.md](docs/API.md) | Build on the network using its API |

---

## What you need

- **Just chatting:** nothing but a browser (or Python 3.10+ for the desktop app).
- **Phone Earn (browser):** same mobile app — keep the tab open (experimental; desktop Ollama is still the full path).
- **Providing compute (desktop):** Python 3.10+, and [Ollama](https://ollama.com) with a model.
- Install Python dependencies with `pip install -r requirements.txt`.

## Questions or ideas?

Email **dev@noeticompute.com**, or open an issue or pull request right here on GitHub.
Contributions are welcome.
