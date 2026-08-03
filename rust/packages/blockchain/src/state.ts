import type { Transaction, TransactionType } from '@noetis/protocol';

export interface ChainAccountState {
  balances: Map<string, number>;
  escrows: Map<string, { user: string; amount: number }>;
}

export function createAccountState(): ChainAccountState {
  return { balances: new Map(), escrows: new Map() };
}

export function getBalance(state: ChainAccountState, address: string): number {
  return state.balances.get(address) ?? 0;
}

function credit(state: ChainAccountState, to: string, amount: number): void {
  state.balances.set(to, getBalance(state, to) + amount);
}

function debit(state: ChainAccountState, from: string, amount: number): boolean {
  const bal = getBalance(state, from);
  if (bal < amount) return false;
  state.balances.set(from, bal - amount);
  return true;
}

export function applyTransaction(state: ChainAccountState, tx: Transaction): boolean {
  switch (tx.type as TransactionType) {
    case 'WALLET_CREATED':
      if (tx.to) state.balances.set(tx.to, getBalance(state, tx.to));
      return true;
    case 'FAUCET_TRANSFER':
      if (tx.to) credit(state, tx.to, tx.amount);
      return true;
    case 'CURRENCY_TRANSFER':
      if (!tx.from || !tx.to) return false;
      if (!debit(state, tx.from, tx.amount)) return false;
      credit(state, tx.to, tx.amount);
      return true;
    case 'TASK_FUNDED': {
      const taskId = tx.metadata.task_id as string;
      if (!tx.from || !taskId) return false;
      if (!debit(state, tx.from, tx.amount)) return false;
      state.escrows.set(taskId, { user: tx.from, amount: tx.amount });
      return true;
    }
    case 'TASK_PAID':
    case 'TASK_REFUNDED':
      if (tx.to) credit(state, tx.to, tx.amount);
      return true;
    case 'NODE_STAKED':
      if (tx.from) return debit(state, tx.from, tx.amount);
      return false;
    case 'NODE_PENALIZED':
      if (tx.from) {
        debit(state, tx.from, Math.min(tx.amount, getBalance(state, tx.from)));
      }
      return true;
    default:
      return true;
  }
}

export function applyBlockTransactions(state: ChainAccountState, transactions: Transaction[]): boolean {
  for (const tx of transactions) {
    if (!applyTransaction(state, tx)) return false;
  }
  return true;
}

export function deriveStateFromChain(transactions: Transaction[][]): ChainAccountState {
  const state = createAccountState();
  for (const blockTxs of transactions) {
    applyBlockTransactions(state, blockTxs);
  }
  return state;
}
