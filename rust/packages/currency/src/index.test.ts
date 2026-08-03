import { describe, it, expect } from 'vitest';
import {
  createLedger,
  createWalletAccount,
  faucetTransfer,
  lockEscrow,
  settleEscrow,
  estimateTaskPrice,
  getBalance,
} from './index.js';

describe('currency', () => {
  it('faucet and escrow flow', () => {
    const ledger = createLedger();
    const user = 'noet1user';
    createWalletAccount(ledger, user);
    faucetTransfer(ledger, user);
    expect(getBalance(ledger, user)).toBe(1000);

    const price = estimateTaskPrice({
      inputTokens: 100,
      maxOutputTokens: 200,
      model: 'llama3.2:3b',
      nodeCount: 1,
      verificationLevel: 'low',
      nodeInputPrice: 0.00001,
      nodeOutputPrice: 0.00003,
    });
    expect(price).toBeGreaterThan(0);

    lockEscrow(ledger, 'task-1', user, price);
    expect(getBalance(ledger, user)).toBeLessThan(1000);

    const node = 'noet1node';
    createWalletAccount(ledger, node);
    const { refunds } = settleEscrow(ledger, 'task-1', [
      { to: node, amount: price * 0.9, type: 'TASK_PAID' },
    ]);
    expect(refunds).toBeGreaterThan(0);
    expect(getBalance(ledger, node)).toBeGreaterThan(0);
  });
});
