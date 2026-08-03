import type { Transaction } from '@noetis/protocol';
import { randomUUID } from 'node:crypto';

export class Mempool {
  private txs = new Map<string, Transaction>();
  private seen = new Set<string>();

  add(tx: Transaction): boolean {
    const key = tx.id || `${tx.type}:${tx.from}:${tx.timestamp}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.txs.set(tx.id, tx);
    return true;
  }

  list(): Transaction[] {
    return [...this.txs.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  drain(): Transaction[] {
    const all = this.list();
    this.txs.clear();
    return all;
  }

  remove(ids: string[]): void {
    for (const id of ids) this.txs.delete(id);
  }

  size(): number {
    return this.txs.size;
  }
}

export function createTx(
  type: Transaction['type'],
  from: string | null,
  to: string | null,
  amount: number,
  metadata: Record<string, unknown> = {}
): Transaction {
  return {
    id: randomUUID(),
    type,
    from,
    to,
    amount,
    metadata,
    timestamp: Date.now(),
  };
}
