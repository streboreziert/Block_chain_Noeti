import type { Transaction, TransactionType } from '@noetis/protocol';
import { randomUUID } from 'node:crypto';

export interface EscrowRecord {
  taskId: string;
  userAddress: string;
  lockedAmount: number;
  spentAmount: number;
  status: 'locked' | 'released' | 'settled';
}

export interface LedgerState {
  balances: Map<string, number>;
  escrows: Map<string, EscrowRecord>;
  transactions: Transaction[];
  usedNonces: Set<string>;
}

export const FAUCET_AMOUNT = 1000;
export const FAUCET_COOLDOWN_MS = 60_000;
export const NETWORK_FEE_RATE = 0.02;
export const VALIDATOR_REWARD_RATE = 0.01;
export const NODE_STAKE_AMOUNT = 10;

const faucetLastClaim = new Map<string, number>();

export function createLedger(): LedgerState {
  return {
    balances: new Map(),
    escrows: new Map(),
    transactions: [],
    usedNonces: new Set(),
  };
}

export function getBalance(ledger: LedgerState, address: string): number {
  return ledger.balances.get(address) ?? 0;
}

function recordTx(
  ledger: LedgerState,
  type: TransactionType,
  from: string | null,
  to: string | null,
  amount: number,
  metadata: Record<string, unknown> = {}
): Transaction {
  const tx: Transaction = {
    id: randomUUID(),
    type,
    from,
    to,
    amount,
    metadata,
    timestamp: Date.now(),
  };
  ledger.transactions.push(tx);
  return tx;
}

export function createWalletAccount(ledger: LedgerState, address: string): Transaction {
  if (!ledger.balances.has(address)) {
    ledger.balances.set(address, 0);
  }
  return recordTx(ledger, 'WALLET_CREATED', null, address, 0, { address });
}

export function faucetTransfer(ledger: LedgerState, address: string): { tx: Transaction; amount: number } {
  const last = faucetLastClaim.get(address) ?? 0;
  if (Date.now() - last < FAUCET_COOLDOWN_MS) {
    throw new Error('Faucet cooldown active. Development-only faucet allows one claim per minute.');
  }
  const balance = getBalance(ledger, address);
  ledger.balances.set(address, balance + FAUCET_AMOUNT);
  faucetLastClaim.set(address, Date.now());
  const tx = recordTx(ledger, 'FAUCET_TRANSFER', 'faucet-dev-only', address, FAUCET_AMOUNT, {
    note: 'DEVELOPMENT ONLY — test NOET has no real value',
  });
  return { tx, amount: FAUCET_AMOUNT };
}

export function transfer(
  ledger: LedgerState,
  from: string,
  to: string,
  amount: number,
  metadata: Record<string, unknown> = {}
): Transaction {
  if (amount <= 0) throw new Error('Amount must be positive');
  const fromBalance = getBalance(ledger, from);
  if (fromBalance < amount) throw new Error('Insufficient balance');
  ledger.balances.set(from, fromBalance - amount);
  ledger.balances.set(to, getBalance(ledger, to) + amount);
  return recordTx(ledger, 'CURRENCY_TRANSFER', from, to, amount, metadata);
}

export function lockEscrow(ledger: LedgerState, taskId: string, userAddress: string, amount: number): EscrowRecord {
  const balance = getBalance(ledger, userAddress);
  if (balance < amount) throw new Error('Insufficient balance for escrow');
  ledger.balances.set(userAddress, balance - amount);
  const escrow: EscrowRecord = { taskId, userAddress, lockedAmount: amount, spentAmount: 0, status: 'locked' };
  ledger.escrows.set(taskId, escrow);
  recordTx(ledger, 'TASK_FUNDED', userAddress, `escrow:${taskId}`, amount, { taskId });
  return escrow;
}

export function settleEscrow(
  ledger: LedgerState,
  taskId: string,
  payments: Array<{ to: string; amount: number; type: TransactionType }>
): { refunds: number; txs: Transaction[] } {
  const escrow = ledger.escrows.get(taskId);
  if (!escrow) throw new Error('Escrow not found');
  const txs: Transaction[] = [];
  let spent = 0;
  for (const payment of payments) {
    if (payment.amount <= 0) continue;
    spent += payment.amount;
    ledger.balances.set(payment.to, getBalance(ledger, payment.to) + payment.amount);
    txs.push(recordTx(ledger, payment.type, `escrow:${taskId}`, payment.to, payment.amount, { taskId }));
  }
  const refund = escrow.lockedAmount - spent;
  if (refund > 0) {
    ledger.balances.set(escrow.userAddress, getBalance(ledger, escrow.userAddress) + refund);
    txs.push(recordTx(ledger, 'TASK_REFUNDED', `escrow:${taskId}`, escrow.userAddress, refund, { taskId }));
  }
  escrow.spentAmount = spent;
  escrow.status = 'settled';
  return { refunds: refund, txs };
}

export function stakeNode(ledger: LedgerState, nodeAddress: string): Transaction {
  transfer(ledger, nodeAddress, 'staking-pool', NODE_STAKE_AMOUNT, { reason: 'node_stake' });
  return recordTx(ledger, 'NODE_STAKED', nodeAddress, 'staking-pool', NODE_STAKE_AMOUNT);
}

export function penalizeNode(ledger: LedgerState, nodeAddress: string, amount: number, reason: string): Transaction {
  const stake = Math.min(amount, getBalance(ledger, nodeAddress));
  if (stake > 0) {
    ledger.balances.set(nodeAddress, getBalance(ledger, nodeAddress) - stake);
  }
  return recordTx(ledger, 'NODE_PENALIZED', nodeAddress, 'penalty-pool', stake, { reason });
}

export interface PriceEstimateInput {
  inputTokens: number;
  maxOutputTokens: number;
  model: string;
  nodeCount: number;
  verificationLevel: 'low' | 'medium' | 'high';
  nodeInputPrice: number;
  nodeOutputPrice: number;
}

const MODEL_SIZE_MULTIPLIER: Record<string, number> = {
  'llama3.2:1b': 1,
  'llama3.2:3b': 1.5,
  'llama3.2': 1.5,
  'llama3.1:8b': 2,
  'mistral:7b': 2,
  default: 1.2,
};

export function estimateTaskPrice(input: PriceEstimateInput): number {
  const modelKey = Object.keys(MODEL_SIZE_MULTIPLIER).find((k) => input.model.includes(k)) ?? 'default';
  const modelMultiplier = MODEL_SIZE_MULTIPLIER[modelKey] ?? MODEL_SIZE_MULTIPLIER.default;
  const verificationMultiplier = input.verificationLevel === 'high' ? 3 : input.verificationLevel === 'medium' ? 2 : 1;
  const base =
    input.inputTokens * input.nodeInputPrice + input.maxOutputTokens * input.nodeOutputPrice;
  const nodeCost = base * modelMultiplier * input.nodeCount * verificationMultiplier;
  const networkFee = nodeCost * NETWORK_FEE_RATE;
  const validatorFee = nodeCost * VALIDATOR_REWARD_RATE;
  return Math.ceil((nodeCost + networkFee + validatorFee) * 1_000_000) / 1_000_000;
}

export function totalSupply(ledger: LedgerState): number {
  let total = 0;
  for (const bal of ledger.balances.values()) total += bal;
  return total;
}
