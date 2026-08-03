#!/usr/bin/env python3
"""Join the Noetis network as a compute provider — E2E encrypted tasks + attestation."""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "connection-layer"))

from attestation import build_attestation  # noqa: E402
from chain_state import MIN_STAKE  # noqa: E402
from crypto_wallet import get_or_create_wallet  # noqa: E402
from task_crypto import decrypt_task, generate_enc_keypair  # noqa: E402
from net_utils import get_lan_ip  # noqa: E402
from utils.ollama_client import NOETI_SYSTEM_PREAMBLE, OllamaClient, OllamaError  # noqa: E402

DEFAULT_HUB = "http://127.0.0.1:5052"
POLL_INTERVAL = 1.0
ENC_DIR = ROOT / "connection-layer" / "data" / "wallets"


def api_call(hub: str, method: str, path: str, body: dict | None = None) -> dict:
    url = f"{hub.rstrip('/')}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Hub error {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Cannot reach hub at {hub}") from exc


def enc_key_path(node_id: str) -> Path:
    return ENC_DIR / f"enc-{node_id}.json"


def load_enc_keys(node_id: str) -> tuple[str, str]:
    path = enc_key_path(node_id)
    if path.exists():
        payload = json.loads(path.read_text())
        return payload["enc_pubkey"], payload["enc_privkey"]
    pub, priv = generate_enc_keypair()
    ENC_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"enc_pubkey": pub, "enc_privkey": priv}, indent=2))
    path.chmod(0o600)
    return pub, priv


def ensure_stake(hub: str, wallet_name: str, node_id: str) -> tuple[str, object]:
    wallet = get_or_create_wallet(wallet_name)
    status = api_call(
        hub,
        "GET",
        f"/api/staking/status?address={wallet.address}&node_id={node_id}",
    )
    if status.get("eligible"):
        return wallet.address, wallet

    balance = api_call(hub, "GET", f"/api/wallet/balance?address={wallet.address}")
    total = float(balance.get("total", 0))
    if total < MIN_STAKE:
        try:
            api_call(hub, "POST", "/api/faucet", {"address": wallet.address, "amount": 100})
            print(f"[wallet] Faucet credited MLC to {wallet.address}")
        except Exception as exc:
            detail = str(exc)
            if "disabled" in detail.lower() or "faucet" in detail.lower():
                print(
                    f"ERROR: Need {MIN_STAKE} MLC staked — transfer MLC or earn; faucet is off.\n"
                    f"  python3 wallet_cli.py create --name {wallet_name}\n"
                    f"  python3 wallet_cli.py stake --hub {hub} --node-id {node_id}"
                )
            else:
                print(
                    f"ERROR: Need {MIN_STAKE} MLC staked — transfer MLC or earn; faucet is off.\n"
                    f"  ({detail})"
                )
            sys.exit(1)

    nonce = int(api_call(hub, "GET", f"/api/wallet/nonce?address={wallet.address}").get("nonce", 0))
    stake_tx = wallet.sign_transaction(
        {
            "type": "stake",
            "from": wallet.address,
            "amount": MIN_STAKE,
            "node_id": node_id,
            "nonce": nonce,
            "timestamp": time.time(),
        }
    )
    api_call(hub, "POST", "/api/transfer", stake_tx)
    print(f"[wallet] Staked {MIN_STAKE} MLC on-chain")
    return wallet.address, wallet


def main() -> None:
    parser = argparse.ArgumentParser(description="Join Noetis network as compute")
    parser.add_argument("--hub", default=DEFAULT_HUB, help="Network hub URL")
    parser.add_argument("--id", dest="node_id", required=True, help="Your compute node name")
    parser.add_argument("--model", default="qwen2.5:0.5b", help="Ollama model")
    parser.add_argument("--wallet", default="", help="Wallet name (default: compute-<node_id>)")
    parser.add_argument("--access-url", default="", help="Public access URL for this node (shown on entry.txt)")
    args = parser.parse_args()

    client = OllamaClient(model=args.model)
    if not client.is_available():
        print("ERROR: Ollama not running. Install https://ollama.com and run: ollama serve")
        sys.exit(1)

    try:
        model = client.resolve_model([args.model, "qwen2.5:0.5b", "llama3.2:1b"])
    except OllamaError as exc:
        print(f"ERROR: {exc}")
        sys.exit(1)

    wallet_name = args.wallet or f"compute-{args.node_id}"
    wallet_address, wallet = ensure_stake(args.hub, wallet_name, args.node_id)
    enc_pubkey, enc_privkey = load_enc_keys(args.node_id)

    print(f"Compute node: {args.node_id}")
    print(f"Wallet:       {wallet_address}")
    print(f"E2E encrypt:  {enc_pubkey[:20]}…")
    print(f"Hub:          {args.hub}")
    print(f"Model:        {model}")
    print("Waiting for inference tasks… (Ctrl+C to stop)\n", flush=True)

    access_url = args.access_url.strip() or f"http://{get_lan_ip()}:11434"

    api_call(
        args.hub,
        "POST",
        "/api/compute/register",
        {
            "node_id": args.node_id,
            "model": model,
            "wallet_address": wallet_address,
            "enc_pubkey": enc_pubkey,
            "access_url": access_url,
        },
    )

    def fetch_task() -> dict | None:
        # Mesh-first: open offers → claim, then poll fallback.
        try:
            offers_payload = api_call(
                args.hub, "GET", f"/api/compute/offers?node_id={args.node_id}"
            )
            offers = offers_payload.get("offers") or []
            if offers:
                tid = str(offers[0].get("task_id", "")).strip()
                if tid:
                    claimed = api_call(
                        args.hub,
                        "POST",
                        "/api/compute/claim",
                        {"node_id": args.node_id, "task_id": tid},
                    )
                    if claimed and claimed.get("task_id"):
                        return claimed
        except Exception as exc:
            print(f"[warn] offers/claim: {exc}")
        task = api_call(args.hub, "GET", f"/api/compute/poll?node_id={args.node_id}")
        return task if task and task.get("task_id") else None

    while True:
        try:
            api_call(args.hub, "POST", "/api/compute/heartbeat", {"node_id": args.node_id})
            task = fetch_task()
            if task and task.get("task_id"):
                task_id = task["task_id"]
                prompt = decrypt_task(task, enc_privkey)
                prompt_hash = task.get("prompt_hash", "")
                num_predict = task.get("num_predict")
                if num_predict is None:
                    num_predict = task.get("max_tokens")
                try:
                    num_predict = int(num_predict) if num_predict is not None else None
                    if num_predict is not None:
                        num_predict = max(128, min(2048, num_predict))
                except (TypeError, ValueError):
                    num_predict = None
                print(f"[task] {task_id}: {prompt[:80]}…")
                started = time.perf_counter()
                result = client.generate(prompt, system=NOETI_SYSTEM_PREAMBLE, num_predict=num_predict)
                elapsed = (time.perf_counter() - started) * 1000
                attestation = build_attestation(
                    wallet,
                    task_id=task_id,
                    model=result.model,
                    response=result.response,
                    inference_ms=elapsed,
                    prompt_hash=prompt_hash,
                )
                body = {
                    "task_id": task_id,
                    "node_id": args.node_id,
                    "response": result.response,
                    "inference_ms": elapsed,
                    "model": result.model,
                    "attestation": attestation,
                }
                if task.get("encrypted") and task.get("ephem_pubkey"):
                    from task_crypto import encrypt_response

                    body.update(encrypt_response(result.response, task["ephem_pubkey"], enc_privkey))
                    body["response"] = ""
                api_call(args.hub, "POST", "/api/compute/result", body)
                print(f"[done] {task_id} in {elapsed:.0f}ms (attested)")
        except KeyboardInterrupt:
            print("\nCompute node stopped.")
            break
        except Exception as exc:
            print(f"[warn] {exc}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
