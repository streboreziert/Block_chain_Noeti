# Connection Layer — Decentralized AI Inference

Proof-of-concept demonstrating **useful decentralized compute** instead of wasteful Proof-of-Work hashing.

Traditional blockchains (e.g. Bitcoin) secure the network with hash computation that has no value outside consensus. This prototype replaces that idea with **distributed LLM inference**: independent worker nodes run real AI tasks locally and receive rewards for contributing compute.

Large models are trained separately. The blockchain layer (future work) coordinates verification and incentives. **This branch implements the connection layer** — socket networking, task routing, consensus, and rewards.

---

## Core idea

```text
User prompt
    ↓
Client
    ↓
Coordinator  ──task──►  Worker 1  ──Ollama──►  inference
              ──task──►  Worker 2  ──Ollama──►  inference
              ──task──►  Worker N  ──Ollama──►  inference
    ↓
Verify (majority consensus) + reward faster workers
    ↓
Response to client
```

- **Coordinator** — routes tasks, collects responses, verifies, assigns rewards
- **Workers** — independent processes performing **real local LLM inference**
- **Client** — submits prompts
- **Rewards** — modular; faster workers matching consensus earn more

---

## Requirements

1. **Python 3.10+**
2. **[Ollama](https://ollama.com)** running locally

```bash
# Install Ollama, then pull a lightweight model:
ollama pull llama3.2:1b
# alternatives: qwen2.5:0.5b, phi3:mini
```

No fake inference — workers call Ollama's HTTP API directly.

---

## Quick start

### 1. Start the web dashboard (recommended)

```bash
cd connection-layer
pip install -r requirements.txt
python3 web.py --workers 10
```

Open **[http://127.0.0.1:5051](http://127.0.0.1:5051)** — live socket network graph, protocol log, prompt form.

### 2. Or use the CLI demo

```bash
chmod +x run_demo.sh
./run_demo.sh
python3 client.py "What is decentralized inference?"
```

The coordinator prints worker ID, inference time, response, and reward for each task.

---

## Manual start

**Terminal 1 — coordinator**

```bash
python3 coordinator.py
```

**Terminals 2–11 — workers**

```bash
python3 worker.py --id worker-01
python3 worker.py --id worker-02
# ... up to worker-10
```

**Terminal 12 — client**

```bash
python3 client.py "Your prompt here"
```

---

## Project structure

```text
connection-layer/
├── coordinator.py      # Task routing, verification, reward logging
├── worker.py           # Worker process — local Ollama inference
├── client.py           # Submit prompts
├── reward.py           # Reward calculation (swappable for token economics)
├── run_demo.sh         # Start coordinator + 10 workers
├── models/
│   └── task.py         # Task / result data models
└── utils/
    ├── protocol.py     # JSON-line socket messages
    └── ollama_client.py # Ollama HTTP client
```

---

## Protocol (JSON lines over TCP)

| Message | Direction | Purpose |
|---------|-----------|---------|
| `register` | worker → coordinator | Join the network |
| `registered` | coordinator → worker | Acknowledge worker |
| `task` | coordinator → worker | Inference assignment |
| `result` | worker → coordinator | Inference output + timing |
| `prompt` | client → coordinator | User request |
| `task_complete` | coordinator → client | Consensus response + rewards |

Default port: **9600**

---

## Verification & rewards

1. Coordinator dispatches the same prompt to all connected workers
2. Each worker runs **independent** Ollama inference
3. Coordinator picks consensus via **majority vote** (normalized text comparison)
4. Workers matching consensus receive rewards
5. Faster workers receive a larger share (inverse latency weighting)

See `reward.py` — designed to be replaced with on-chain token logic later.

---

## Design goals

| Goal | Status |
|------|--------|
| Real local LLM inference (Ollama) | Implemented |
| ~10 independent worker processes | Implemented |
| Socket-based modular networking | Implemented |
| Coordinator verification + rewards | Implemented |
| Blockchain integration | Future work |
| Production security (Sybil, staking) | Future work |

---

## Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Coordinator host |
| `--port` | `9600` | Coordinator port |
| `--model` | `llama3.2:1b` | Ollama model per worker |
| `--reward` | `10.0` | Base reward pool per task |
| `WORKERS` env | `10` | Workers started by `run_demo.sh` |

---

## Troubleshooting

**Ollama not reachable**

```bash
ollama serve
ollama pull llama3.2:1b
```

**No workers connected**

Start workers before submitting prompts, or use `./run_demo.sh`.

**Slow first response**

First inference loads the model into memory. Subsequent tasks are faster.

---

## Relation to other code on this branch

This directory contains the **primary proof-of-concept** for decentralized inference.

The repository also includes an earlier proof-of-learning blockchain prototype (`app.py`, `network_sim.py`, etc.) exploring federated training coordination. That code is kept for reference; the inference grid in `connection-layer/` demonstrates the current project direction.

---

## License

TBD.
