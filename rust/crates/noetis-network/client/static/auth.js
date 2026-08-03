/** Account vault — username + password encrypts Ed25519 private key (WebCrypto). */

import * as ed from "https://esm.sh/@noble/ed25519@2.1.0";
import { createWallet, loadWallet } from "./wallet.js";

const VAULTS_KEY = "noetis_vaults_v1";
const ACTIVE_USER_KEY = "noetis_active_user";
const CONTACTS_KEY = "noetis_contacts_v1";
const WALLET_KEY = "noetis_wallet";
const PBKDF2_ITERS = 120000;

/** @type {{ username: string, wallet: object } | null} */
let session = null;

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

function b64encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function loadVaults() {
  try {
    const raw = localStorage.getItem(VAULTS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function saveVaults(vaults) {
  localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults));
}

export function loadContacts() {
  try {
    const raw = localStorage.getItem(CONTACTS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

export function saveContact(username, address) {
  const u = String(username || "")
    .trim()
    .toLowerCase();
  const a = String(address || "").trim();
  if (!u || !a) return;
  const contacts = loadContacts();
  contacts[u] = a;
  try {
    localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts));
  } catch (_) {}
}

export function resolveRecipient(to) {
  const raw = String(to || "").trim();
  if (!raw) return null;
  if (raw.startsWith("mlc") && raw.length >= 20) return raw;
  const key = raw.toLowerCase();
  const contacts = loadContacts();
  if (contacts[key]) return contacts[key];
  const vaults = loadVaults();
  if (vaults[key]?.address) return vaults[key].address;
  // Case-insensitive vault lookup
  for (const [name, v] of Object.entries(vaults)) {
    if (String(name).toLowerCase() === key && v?.address) return v.address;
  }
  return null;
}

export function getActiveUsername() {
  try {
    return localStorage.getItem(ACTIVE_USER_KEY) || "";
  } catch {
    return "";
  }
}

export function isLoggedIn() {
  return !!(session && session.username && session.wallet?.private_key_hex);
}

export function getSession() {
  return session;
}

function persistSessionWallet(wallet) {
  if (!wallet) return;
  localStorage.setItem(WALLET_KEY, JSON.stringify(wallet));
}

async function deriveAesKey(password, saltBytes) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptPrivateKey(privateKeyHex, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt);
  const plaintext = new TextEncoder().encode(privateKeyHex);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    salt: b64encode(salt),
    iv: b64encode(iv),
    ciphertext: b64encode(new Uint8Array(cipherBuf)),
  };
}

async function decryptPrivateKey(entry, password) {
  const salt = b64decode(entry.salt);
  const iv = b64decode(entry.iv);
  const ciphertext = b64decode(entry.ciphertext);
  const key = await deriveAesKey(password, salt);
  try {
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plainBuf);
  } catch {
    throw new Error("Wrong password");
  }
}

function normalizeUsername(username) {
  const u = String(username || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(u)) {
    throw new Error("username: 3–24 chars, a-z 0-9 _");
  }
  return u;
}

/**
 * Sign up: create (or reuse guest) wallet, encrypt into vault, unlock session.
 * @param {{ username: string, password: string, confirm?: string, migrateGuest?: boolean }} opts
 */
export async function signup({ username, password, confirm, migrateGuest = true } = {}) {
  const u = normalizeUsername(username);
  if (!password || String(password).length < 6) throw new Error("password min 6 characters");
  if (confirm != null && String(confirm) !== String(password)) {
    throw new Error("passwords do not match");
  }
  const vaults = loadVaults();
  if (vaults[u]) throw new Error("username already taken on this device");

  let wallet = null;
  if (migrateGuest) {
    const existing = loadWallet();
    if (existing?.private_key_hex && existing?.address) {
      wallet = existing;
    }
  }
  if (!wallet) {
    wallet = await createWallet();
  }

  const enc = await encryptPrivateKey(wallet.private_key_hex, password);
  vaults[u] = {
    address: wallet.address,
    public_key: wallet.public_key,
    salt: enc.salt,
    iv: enc.iv,
    ciphertext: enc.ciphertext,
    createdAt: Date.now(),
  };
  saveVaults(vaults);
  saveContact(u, wallet.address);
  localStorage.setItem(ACTIVE_USER_KEY, u);
  session = { username: u, wallet };
  persistSessionWallet(wallet);
  return { username: u, wallet, migrated: migrateGuest && !!loadWallet() };
}

export async function login({ username, password } = {}) {
  const u = normalizeUsername(username);
  if (!password) throw new Error("password required");
  const vaults = loadVaults();
  const entry = vaults[u];
  if (!entry) throw new Error("unknown username on this device");
  const privateHex = await decryptPrivateKey(entry, password);
  const privateKey = hexToBytes(privateHex);
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const publicKeyHex = bytesToHex(publicKey);
  const wallet = {
    name: u,
    address: entry.address || `mlc${publicKeyHex.slice(0, 42)}`,
    public_key: entry.public_key || publicKeyHex,
    private_key_hex: privateHex,
    created_at: entry.createdAt ? Math.floor(entry.createdAt / 1000) : Math.floor(Date.now() / 1000),
  };
  session = { username: u, wallet };
  localStorage.setItem(ACTIVE_USER_KEY, u);
  saveContact(u, wallet.address);
  persistSessionWallet(wallet);
  return { username: u, wallet };
}

export function logout() {
  session = null;
  try {
    localStorage.removeItem(WALLET_KEY);
  } catch (_) {}
  try {
    localStorage.removeItem(ACTIVE_USER_KEY);
  } catch (_) {}
}

/** Try restore session from active user + existing unlocked wallet (same tab reload). */
export function tryRestoreSession() {
  const u = getActiveUsername();
  if (!u) {
    session = null;
    return null;
  }
  const w = loadWallet();
  const vaults = loadVaults();
  const entry = vaults[u];
  if (w?.private_key_hex && entry && w.address === entry.address) {
    session = { username: u, wallet: w };
    return session;
  }
  // Vault exists but wallet locked — keep username hint, no session keys
  session = null;
  return null;
}

export function hasGuestWalletWithoutVault() {
  const w = loadWallet();
  if (!w?.private_key_hex) return false;
  const vaults = loadVaults();
  return !Object.values(vaults).some((v) => v?.address === w.address);
}

export function shortAddress(addr) {
  const a = String(addr || "");
  if (a.length < 16) return a || "—";
  return `${a.slice(0, 10)}…${a.slice(-6)}`;
}
