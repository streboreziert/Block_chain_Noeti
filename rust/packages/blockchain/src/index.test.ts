import { describe, it, expect } from 'vitest';
import { createWallet } from '@noetis/crypto';
import {
  createBlockchain,
  proposeBlock,
  applyBlock,
  attestBlock,
  validateChain,
  MultiValidatorConsensus,
  quorumSize,
} from './index.js';

describe('blockchain', () => {
  it('produces multi-validator attested blocks', async () => {
    const w1 = await createWallet();
    const w2 = await createWallet();
    const v1 = { id: 'v1', publicKey: w1.publicKey, wallet: w1 };
    const v2 = { id: 'v2', publicKey: w2.publicKey, wallet: w2 };
    const state = await createBlockchain([v1, v2]);
    expect(quorumSize(2)).toBe(2);

    const proposed = await proposeBlock(state, v1);
    const attested = await attestBlock(proposed, v2);
    applyBlock(state, attested);

    const consensus = new MultiValidatorConsensus([v1, v2]);
    expect(await consensus.validateChain(state)).toBe(true);
    expect(state.chain.length).toBe(2);
  });
});
