import * as ed from '@noble/ed25519';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function signMessageDev(message: string, privateKeyHex: string): Promise<string> {
  const secretKey = hexToBytes(privateKeyHex);
  const sig = await ed.signAsync(utf8ToBytes(message), secretKey);
  return encodeBase64(sig);
}
