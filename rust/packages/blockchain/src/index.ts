import type { Block, Transaction } from '@noetis/protocol';
import { hash, signMessage, verifySignature, type Wallet } from '@noetis/crypto';

export interface Validator {
  id: string;
  publicKey: string;
  wallet: Wallet;
  stake?: number;
}

export interface BlockchainState {
  chain: Block[];
  validators: Validator[];
  pendingTransactions: Transaction[];
  pendingSettlements: Array<Record<string, unknown>>;
}

export interface AttestedBlock extends Block {
  validator_signatures?: Record<string, string>;
  proposer_id?: string;
}

const GENESIS_PREVIOUS = '0'.repeat(64);

export type BlockBody = Omit<Block, 'hash'> & {
  validator_signatures?: Record<string, string>;
  proposer_id?: string;
};

export function computeBlockHash(block: BlockBody): string {
  const payload = JSON.stringify({
    block_number: block.block_number,
    previous_hash: block.previous_hash,
    timestamp: block.timestamp,
    transactions: block.transactions,
    task_settlements: block.task_settlements,
    proposer_id: block.proposer_id ?? '',
  });
  return hash(payload);
}

export function createGenesisBlock(validators: Validator[]): AttestedBlock {
  const proposer = validators[0];
  const block: BlockBody = {
    block_number: 0,
    previous_hash: GENESIS_PREVIOUS,
    timestamp: Date.now(),
    transactions: [],
    task_settlements: [],
    validator_signature: '',
    validator_signatures: {},
    proposer_id: proposer?.id ?? 'genesis',
  };
  return { ...block, hash: computeBlockHash(block) };
}

export async function createBlockchain(validators: Validator[]): Promise<BlockchainState> {
  const genesis = createGenesisBlock(validators);
  if (validators[0]) {
    genesis.validator_signature = await signBlockBody(genesis, validators[0]);
    genesis.validator_signatures = { [validators[0].id]: genesis.validator_signature };
  }
  return {
    chain: [genesis],
    validators,
    pendingTransactions: [],
    pendingSettlements: [],
  };
}

export async function signBlockBody(block: BlockBody, validator: Validator): Promise<string> {
  return signMessage(computeBlockHash(block), validator.wallet);
}

export function getLatestBlock(state: BlockchainState): Block {
  return state.chain[state.chain.length - 1];
}

export function getBlockHeight(state: BlockchainState): number {
  return state.chain.length - 1;
}

export function queueTransaction(state: BlockchainState, tx: Transaction): void {
  state.pendingTransactions.push(tx);
}

export function queueSettlement(state: BlockchainState, settlement: Record<string, unknown>): void {
  state.pendingSettlements.push(settlement);
}

export function quorumSize(validatorCount: number): number {
  return Math.floor(validatorCount * 2 / 3) + 1;
}

export function getProposer(validators: Validator[], blockNumber: number): Validator {
  const idx = blockNumber % validators.length;
  return validators[idx];
}

export async function proposeBlock(state: BlockchainState, proposer: Validator): Promise<AttestedBlock> {
  const latest = getLatestBlock(state);
  const blockBody: BlockBody = {
    block_number: latest.block_number + 1,
    previous_hash: latest.hash,
    timestamp: Date.now(),
    transactions: [...state.pendingTransactions],
    task_settlements: [...state.pendingSettlements],
    validator_signature: '',
    validator_signatures: {},
    proposer_id: proposer.id,
  };
  const signature = await signBlockBody(blockBody, proposer);
  blockBody.validator_signature = signature;
  blockBody.validator_signatures = { [proposer.id]: signature };
  const block: AttestedBlock = { ...blockBody, hash: computeBlockHash(blockBody) };
  return block;
}

export async function attestBlock(block: AttestedBlock, validator: Validator): Promise<AttestedBlock> {
  const body: BlockBody = { ...block };
  const sig = await signBlockBody(body, validator);
  return {
    ...block,
    validator_signatures: { ...block.validator_signatures, [validator.id]: sig },
  };
}

export async function validateBlockSignatures(
  block: AttestedBlock,
  previous: Block,
  validators: Validator[]
): Promise<boolean> {
  if (block.hash !== computeBlockHash(block)) return false;
  if (block.previous_hash !== previous.hash) return false;
  if (block.block_number !== previous.block_number + 1) return false;

  const sigs = block.validator_signatures ?? {};
  let validCount = 0;
  for (const v of validators) {
    const sig = sigs[v.id];
    if (!sig) continue;
    const ok = await verifySignature(block.hash, sig, v.publicKey);
    if (ok) validCount++;
  }
  return validCount >= quorumSize(validators.length);
}

export async function validateChain(state: BlockchainState): Promise<boolean> {
  if (state.chain.length === 0) return false;
  for (let i = 1; i < state.chain.length; i++) {
    const ok = await validateBlockSignatures(
      state.chain[i] as AttestedBlock,
      state.chain[i - 1],
      state.validators
    );
    if (!ok) return false;
  }
  return true;
}

export function applyBlock(state: BlockchainState, block: AttestedBlock): void {
  state.chain.push(block);
  state.pendingTransactions = [];
  state.pendingSettlements = [];
}

export function replaceChain(state: BlockchainState, newChain: Block[]): void {
  state.chain = newChain;
}

export interface ConsensusEngine {
  proposeBlock(state: BlockchainState): Promise<AttestedBlock>;
  validateChain(state: BlockchainState): Promise<boolean>;
  quorum(): number;
}

/** Multi-validator BFT-style consensus with round-robin proposer */
export class MultiValidatorConsensus implements ConsensusEngine {
  constructor(private validators: Validator[]) {}

  quorum(): number {
    return quorumSize(this.validators.length);
  }

  async proposeBlock(state: BlockchainState): Promise<AttestedBlock> {
    const proposer = getProposer(this.validators, getBlockHeight(state) + 1);
    return proposeBlock(state, proposer);
  }

  async validateChain(state: BlockchainState): Promise<boolean> {
    return validateChain(state);
  }
}

/** Delegated proof-of-stake interface — validators weighted by stake */
export interface StakeEntry {
  validatorId: string;
  address: string;
  stake: number;
  slashed: number;
}

export class StakeRegistry {
  private stakes = new Map<string, StakeEntry>();

  register(entry: StakeEntry): void {
    this.stakes.set(entry.validatorId, entry);
  }

  getStake(validatorId: string): number {
    return this.stakes.get(validatorId)?.stake ?? 0;
  }

  slash(validatorId: string, amount: number): void {
    const entry = this.stakes.get(validatorId);
    if (!entry) return;
    entry.slashed += amount;
    entry.stake = Math.max(0, entry.stake - amount);
  }

  topValidators(limit: number): StakeEntry[] {
    return [...this.stakes.values()]
      .filter((s) => s.stake > 0)
      .sort((a, b) => b.stake - a.stake)
      .slice(0, limit);
  }

  toJSON(): StakeEntry[] {
    return [...this.stakes.values()];
  }

  static fromJSON(data: StakeEntry[]): StakeRegistry {
    const r = new StakeRegistry();
    for (const e of data) r.register(e);
    return r;
  }
}

/** @deprecated Use MultiValidatorConsensus */
export class ProofOfAuthorityConsensus implements ConsensusEngine {
  constructor(private validator: Validator) {}

  quorum(): number {
    return 1;
  }

  async proposeBlock(state: BlockchainState): Promise<AttestedBlock> {
    return proposeBlock(state, this.validator);
  }

  async validateChain(state: BlockchainState): Promise<boolean> {
    return validateChain({ ...state, validators: [this.validator] });
  }
}

// Legacy exports
export async function produceBlock(state: BlockchainState, validator: Validator): Promise<Block> {
  const block = await proposeBlock(state, validator);
  applyBlock(state, block);
  return block;
}

export async function validateBlock(block: Block, previous: Block, validators: Validator[]): Promise<boolean> {
  return validateBlockSignatures(block as AttestedBlock, previous, validators);
}

export { createGenesisBlock as createGenesisBlockLegacy };

export * from './storage.js';
export * from './state.js';
export * from './mempool.js';
