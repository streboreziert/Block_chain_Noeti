import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import nacl from 'tweetnacl';

function decodeBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function encodeBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

function decodeUTF8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function encodeUTF8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export interface Wallet {
  address: string;
  publicKey: string;
  privateKey: string;
  secretKey: Uint8Array;
  /** X25519 keys for libsodium-compatible box encryption of task payloads */
  boxPublicKey: string;
  boxSecretKey: Uint8Array;
}

export function hash(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? utf8ToBytes(data) : data;
  return bytesToHex(sha256(bytes));
}

export function deriveAddress(publicKeyHex: string): string {
  const digest = sha256(hexToBytes(publicKeyHex));
  return `noet1${bytesToHex(digest).slice(0, 40)}`;
}

export function deriveNodeId(publicKeyHex: string): string {
  return hash(publicKeyHex).slice(0, 32);
}

function createBoxKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return nacl.box.keyPair();
}

export async function createWallet(): Promise<Wallet> {
  const secretKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  const publicKeyHex = bytesToHex(publicKey);
  const box = createBoxKeypair();
  return {
    address: deriveAddress(publicKeyHex),
    publicKey: publicKeyHex,
    privateKey: bytesToHex(secretKey),
    secretKey,
    boxPublicKey: bytesToHex(box.publicKey),
    boxSecretKey: box.secretKey,
  };
}

export async function walletFromPrivateKey(
  privateKeyHex: string,
  boxSecretKeyHex?: string
): Promise<Wallet> {
  const secretKey = hexToBytes(privateKeyHex);
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  const publicKeyHex = bytesToHex(publicKey);
  const box = boxSecretKeyHex
    ? { secretKey: hexToBytes(boxSecretKeyHex), publicKey: nacl.box.keyPair.fromSecretKey(hexToBytes(boxSecretKeyHex)).publicKey }
    : createBoxKeypair();
  return {
    address: deriveAddress(publicKeyHex),
    publicKey: publicKeyHex,
    privateKey: privateKeyHex,
    secretKey,
    boxPublicKey: bytesToHex(box.publicKey),
    boxSecretKey: box.secretKey,
  };
}

export async function signMessage(message: string, wallet: Wallet): Promise<string> {
  const msgBytes = utf8ToBytes(message);
  const sig = await ed.signAsync(msgBytes, wallet.secretKey);
  return encodeBase64(sig);
}

export async function verifySignature(
  message: string,
  signatureBase64: string,
  publicKeyHex: string
): Promise<boolean> {
  try {
    const msgBytes = utf8ToBytes(message);
    const sig = decodeBase64(signatureBase64);
    const pubKey = hexToBytes(publicKeyHex);
    return await ed.verifyAsync(sig, msgBytes, pubKey);
  } catch {
    return false;
  }
}

export function canonicalMessage(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

export async function signPayload(payload: Record<string, unknown>, wallet: Wallet): Promise<string> {
  return signMessage(canonicalMessage(payload), wallet);
}

export async function verifyPayloadSignature(
  payload: Record<string, unknown>,
  signature: string,
  publicKeyHex: string
): Promise<boolean> {
  return verifySignature(canonicalMessage(payload), signature, publicKeyHex);
}

/** libsodium-compatible box encryption (Curve25519 + XSalsa20-Poly1305) — use boxPublicKey */
export function encryptForRecipient(plaintext: string, recipientBoxPublicKeyHex: string): {
  ciphertext: string;
  nonce: string;
  ephemeralPublicKey: string;
} {
  const recipientPublicKey = hexToBytes(recipientBoxPublicKeyHex);
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = encodeUTF8(plaintext);
  const ciphertext = nacl.box(messageBytes, nonce, recipientPublicKey, ephemeral.secretKey);
  return {
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
    ephemeralPublicKey: bytesToHex(ephemeral.publicKey),
  };
}

export function decryptFromSender(
  ciphertextBase64: string,
  nonceBase64: string,
  ephemeralPublicKeyHex: string,
  recipientSecretKey: Uint8Array
): string {
  const ciphertext = decodeBase64(ciphertextBase64);
  const nonce = decodeBase64(nonceBase64);
  const ephemeralPublicKey = hexToBytes(ephemeralPublicKeyHex);
  const opened = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);
  if (!opened) throw new Error('Decryption failed');
  return decodeUTF8(opened);
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function generateNonce(): string {
  return bytesToHex(nacl.randomBytes(16));
}

export interface AuthChallenge {
  wallet_address: string;
  timestamp: number;
  nonce: string;
}

export function buildAuthMessage(challenge: AuthChallenge): string {
  return canonicalMessage(challenge as unknown as Record<string, unknown>);
}

export async function verifyAuthChallenge(
  challenge: AuthChallenge,
  signature: string,
  publicKeyHex: string,
  maxAgeMs = 5 * 60 * 1000
): Promise<boolean> {
  if (Math.abs(Date.now() - challenge.timestamp) > maxAgeMs) return false;
  return verifySignature(buildAuthMessage(challenge), signature, publicKeyHex);
}
