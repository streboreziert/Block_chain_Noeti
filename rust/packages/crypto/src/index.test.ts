import { describe, it, expect } from 'vitest';
import {
  createWallet,
  signPayload,
  verifyPayloadSignature,
  encryptForRecipient,
  decryptFromSender,
  deriveAddress,
  hash,
} from './index.js';

describe('crypto', () => {
  it('creates wallet and signs messages', async () => {
    const wallet = await createWallet();
    expect(wallet.address.startsWith('noet1')).toBe(true);
    const sig = await signPayload({ action: 'test', nonce: '1' }, wallet);
    expect(await verifyPayloadSignature({ action: 'test', nonce: '1' }, sig, wallet.publicKey)).toBe(true);
  });

  it('encrypts and decrypts payloads', async () => {
    const recipient = await createWallet();
    const encrypted = encryptForRecipient('secret prompt', recipient.boxPublicKey);
    const plain = decryptFromSender(
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.ephemeralPublicKey,
      recipient.boxSecretKey
    );
    expect(plain).toBe('secret prompt');
  });

  it('hashes consistently', () => {
    expect(hash('hello')).toHaveLength(64);
    expect(deriveAddress('ab'.repeat(32))).toMatch(/^noet1/);
  });
});
