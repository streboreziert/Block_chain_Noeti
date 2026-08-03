/** Browser Ed25519 wallet — talks to remote hub API only */

import * as ed from "https://esm.sh/@noble/ed25519@2.1.0";

const WALLET_KEY = "noetis_wallet";
const rawHub = document.querySelector('meta[name="noetis-hub"]')?.content || "";
const HUB = rawHub.includes("{{") ? "" : rawHub.replace(/\/$/, "");

export function hubApi(path) {
  return `${HUB}${path.startsWith("/") ? path : `/${path}`}`;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const clean = String(hex || "").replace(/\s+/g, "").toLowerCase();
  if (clean.length % 2) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function canonicalJson(obj) {
  const sorted = {};
  Object.keys(obj)
    .sort()
    .forEach((k) => {
      sorted[k] = obj[k];
    });
  return JSON.stringify(sorted);
}

function addressFromPublicKey(publicKeyHex) {
  return `mlc${publicKeyHex.slice(0, 42)}`;
}

export function loadWallet() {
  const raw = localStorage.getItem(WALLET_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function persistWallet(wallet) {
  localStorage.setItem(WALLET_KEY, JSON.stringify(wallet));
  return wallet;
}

export async function createWallet() {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const publicKeyHex = bytesToHex(publicKey);
  const wallet = {
    name: "browser",
    address: addressFromPublicKey(publicKeyHex),
    public_key: publicKeyHex,
    private_key_hex: bytesToHex(privateKey),
    created_at: Math.floor(Date.now() / 1000),
  };
  return persistWallet(wallet);
}

export async function getOrCreateWallet() {
  const existing = loadWallet();
  if (existing) return existing;
  return createWallet();
}

export function exportWalletBackup(wallet = loadWallet()) {
  if (!wallet) throw new Error("No wallet to export");
  return JSON.stringify(
    {
      version: 1,
      type: "noetis-mlc-wallet",
      address: wallet.address,
      public_key: wallet.public_key,
      private_key_hex: wallet.private_key_hex,
      created_at: wallet.created_at || null,
    },
    null,
    2
  );
}

export async function importWalletBackup(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const privateHex = data.private_key_hex || data.privateKeyHex;
  if (!privateHex) throw new Error("Backup missing private_key_hex");
  const privateKey = hexToBytes(privateHex);
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const publicKeyHex = bytesToHex(publicKey);
  const wallet = {
    name: data.name || "imported",
    address: addressFromPublicKey(publicKeyHex),
    public_key: publicKeyHex,
    private_key_hex: bytesToHex(privateKey),
    created_at: data.created_at || Math.floor(Date.now() / 1000),
  };
  return persistWallet(wallet);
}

export function downloadWalletBackup(wallet = loadWallet()) {
  const blob = new Blob([exportWalletBackup(wallet)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `noetis-wallet-${(wallet.address || "backup").slice(0, 18)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function signTransaction(wallet, tx) {
  const body = { ...tx };
  delete body.signature;
  body.public_key = wallet.public_key;
  const message = new TextEncoder().encode(canonicalJson(body));
  const signature = await ed.signAsync(message, hexToBytes(wallet.private_key_hex));
  return { ...body, signature: bytesToHex(signature) };
}

async function fetchBalanceProof(address) {
  const res = await fetch(hubApi(`/api/wallet/proof?address=${encodeURIComponent(address)}`));
  return res.json();
}

export async function fetchBalance(address) {
  const res = await fetch(hubApi(`/api/wallet/balance?address=${encodeURIComponent(address)}`));
  const balance = await res.json();
  try {
    const proof = await fetchBalanceProof(address);
    balance.spv_verified = proof.verified === true;
  } catch {
    balance.spv_verified = false;
  }
  return balance;
}

export async function fetchNonce(address) {
  const res = await fetch(hubApi(`/api/wallet/nonce?address=${encodeURIComponent(address)}`));
  return res.json();
}

export async function requestFaucet(address) {
  const res = await fetch(hubApi("/api/faucet"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  return { ok: res.ok, data: await res.json() };
}

export async function stakeFromBrowser(wallet, nodeId, amount = 10) {
  const nonceRes = await fetchNonce(wallet.address);
  const tx = await signTransaction(wallet, {
    type: "stake",
    from: wallet.address,
    amount,
    node_id: nodeId,
    nonce: nonceRes.nonce || 0,
    timestamp: Math.floor(Date.now() / 1000),
  });
  const res = await fetch(hubApi("/api/transfer"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tx),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `stake HTTP ${res.status}`);
  return { ok: true, data };
}

/** Faucet if needed, stake, verify hub says eligible for this node_id. */
export async function ensureStakeForNode(wallet, nodeId, amount = 10) {
  const statusUrl = hubApi(
    `/api/staking/status?address=${encodeURIComponent(wallet.address)}&node_id=${encodeURIComponent(nodeId)}`
  );
  let st = await fetch(statusUrl).then((r) => r.json());
  if (st.eligible) {
    return { already: true, status: st };
  }

  let bal = await fetchBalance(wallet.address);
  let liquid = Number(bal.balance ?? bal.available ?? 0);
  const total = Number(bal.total ?? liquid);
  if (liquid < amount && total < amount) {
    const faucet = await requestFaucet(wallet.address);
    if (!faucet.ok) {
      const err = String(faucet.data?.error || "");
      if (/disabled|faucet/i.test(err) || faucet.data?.faucet_enabled === false) {
        throw new Error("transfer MLC or earn — faucet is off");
      }
      throw new Error(err || "transfer MLC or earn — faucet is off");
    }
    await new Promise((r) => setTimeout(r, 500));
    bal = await fetchBalance(wallet.address);
    liquid = Number(bal.balance ?? bal.available ?? 0);
  }
  if (liquid < amount && Number(bal.total ?? 0) < amount) {
    throw new Error(
      `need ${amount} MLC (have ${bal.total ?? liquid}) — transfer MLC or earn; faucet is off`
    );
  }

  // Already staked enough on this node?
  const staked = Number(bal.staked ?? 0);
  if (staked >= amount && st.node_id === nodeId) {
    st = await fetch(statusUrl).then((r) => r.json());
    if (st.eligible) return { already: true, status: st };
  }

  await stakeFromBrowser(wallet, nodeId, amount);
  await new Promise((r) => setTimeout(r, 600));
  st = await fetch(statusUrl).then((r) => r.json());
  if (!st.eligible) {
    throw new Error(st.message || "stake not eligible yet — wait a second and tap Earn again");
  }
  return { already: false, status: st };
}

export async function transferFromBrowser(wallet, to, amount) {
  const nonceRes = await fetchNonce(wallet.address);
  const tx = await signTransaction(wallet, {
    type: "transfer",
    from: wallet.address,
    to,
    amount: Number(amount),
    nonce: nonceRes.nonce || 0,
    timestamp: Math.floor(Date.now() / 1000),
  });
  const res = await fetch(hubApi("/api/transfer"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tx),
  });
  return { ok: res.ok, data: await res.json() };
}

/** First-run: create wallet + claim faucet if empty. */
export async function autoOnboard() {
  const wallet = await getOrCreateWallet();
  const bal = await fetchBalance(wallet.address);
  const total = Number(bal.total ?? bal.balance ?? 0);
  let faucet = null;
  if (total <= 0) {
    faucet = await requestFaucet(wallet.address);
  }
  return { wallet, balance: bal, faucet, created: !loadWallet() ? false : true };
}
