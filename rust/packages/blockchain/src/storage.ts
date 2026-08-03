import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Block, Transaction } from '@noetis/protocol';
import type { BlockchainState } from './index.js';

export interface ChainStoreData {
  chain: Block[];
  validator_ids: string[];
  mempool: Transaction[];
}

export class ChainStore {
  constructor(private filePath: string) {}

  load(): ChainStoreData | null {
    if (!existsSync(this.filePath)) return null;
    return JSON.parse(readFileSync(this.filePath, 'utf8')) as ChainStoreData;
  }

  save(data: ChainStoreData): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  saveState(state: BlockchainState, mempool: Transaction[] = []): void {
    this.save({
      chain: state.chain,
      validator_ids: state.validators.map((v) => v.id),
      mempool,
    });
  }
}

export function pickLongestChain(chains: Block[][]): Block[] {
  if (chains.length === 0) return [];
  return chains.reduce((a, b) => (b.length > a.length ? b : a));
}
