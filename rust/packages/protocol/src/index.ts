import { z } from 'zod';

export const WS_MESSAGE_TYPES = [
  'NODE_REGISTER',
  'NODE_HEARTBEAT',
  'TASK_OFFER',
  'TASK_ACCEPT',
  'TASK_REJECT',
  'TASK_PAYLOAD',
  'TASK_PROGRESS',
  'TASK_RESULT',
  'TASK_CANCEL',
  'REWARD_CONFIRMED',
  'REGISTERED',
  'ERROR',
] as const;

export type WSMessageType = (typeof WS_MESSAGE_TYPES)[number];

export const WSMessageSchema = z.object({
  type: z.enum(WS_MESSAGE_TYPES),
  message_id: z.string().uuid(),
  timestamp: z.number().int().positive(),
  sender: z.string(),
  payload: z.record(z.unknown()),
  signature: z.string(),
});

export type WSMessage = z.infer<typeof WSMessageSchema>;

export const NodeModelSchema = z.object({
  name: z.string(),
  model_hash: z.string(),
  context_length: z.number().int().positive(),
});

export const NodeRegistrationSchema = z.object({
  node_id: z.string(),
  wallet_address: z.string(),
  models: z.array(NodeModelSchema),
  cpu: z.string(),
  gpu: z.string().optional(),
  ram_gb: z.number(),
  vram_gb: z.number().optional(),
  operating_system: z.string(),
  price_per_input_token: z.number().nonnegative(),
  price_per_output_token: z.number().nonnegative(),
  maximum_parallel_tasks: z.number().int().positive(),
  reputation: z.number().default(0),
  status: z.enum(['available', 'busy', 'offline']).default('available'),
  public_key: z.string(),
  box_public_key: z.string().optional(),
  accepts_redundant: z.boolean().default(true),
  minimum_task_payment: z.number().nonnegative().default(0),
  maximum_context_size: z.number().int().positive().optional(),
});

export type NodeRegistration = z.infer<typeof NodeRegistrationSchema>;

export const ProcessingModeSchema = z.enum(['single', 'redundant', 'subtask']);
export type ProcessingMode = z.infer<typeof ProcessingModeSchema>;

export const VerificationLevelSchema = z.enum(['low', 'medium', 'high']);
export type VerificationLevel = z.infer<typeof VerificationLevelSchema>;

export const TaskStatusSchema = z.enum([
  'created',
  'price_estimated',
  'escrow_locked',
  'nodes_found',
  'node_selected',
  'prompt_delivered',
  'inference_started',
  'result_returned',
  'result_verified',
  'node_paid',
  'refunded',
  'finalized',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const CreateTaskRequestSchema = z.object({
  wallet_address: z.string(),
  prompt: z.string().min(1).max(100_000),
  model: z.string(),
  max_output_tokens: z.number().int().min(1).max(8192),
  verification_level: VerificationLevelSchema.default('low'),
  processing_mode: ProcessingModeSchema.default('single'),
  signature: z.string(),
  timestamp: z.number().int(),
  nonce: z.string(),
});

export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const TaskProgressEventSchema = z.object({
  task_id: z.string().uuid(),
  status: TaskStatusSchema,
  message: z.string().optional(),
  timestamp: z.number().int(),
});

export type TaskProgressEvent = z.infer<typeof TaskProgressEventSchema>;

export const TX_TYPES = [
  'WALLET_CREATED',
  'FAUCET_TRANSFER',
  'CURRENCY_TRANSFER',
  'NODE_REGISTERED',
  'NODE_STAKED',
  'TASK_CREATED',
  'TASK_FUNDED',
  'TASK_ASSIGNED',
  'RESULT_SUBMITTED',
  'RESULT_VERIFIED',
  'TASK_PAID',
  'TASK_REFUNDED',
  'NODE_PENALIZED',
] as const;

export type TransactionType = (typeof TX_TYPES)[number];

export const TransactionSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(TX_TYPES),
  from: z.string().nullable(),
  to: z.string().nullable(),
  amount: z.number(),
  metadata: z.record(z.unknown()).default({}),
  timestamp: z.number().int(),
  signature: z.string().optional(),
});

export type Transaction = z.infer<typeof TransactionSchema>;

export const BlockSchema = z.object({
  block_number: z.number().int().nonnegative(),
  previous_hash: z.string(),
  timestamp: z.number().int(),
  transactions: z.array(TransactionSchema),
  task_settlements: z.array(z.record(z.unknown())),
  validator_signature: z.string(),
  hash: z.string(),
  proposer_id: z.string().optional(),
  validator_signatures: z.record(z.string()).optional(),
});

export type Block = z.infer<typeof BlockSchema>;

export const TASK_PROGRESS_LABELS: Record<TaskStatus, string> = {
  created: 'Task created',
  price_estimated: 'Price estimated',
  escrow_locked: 'NOET locked in escrow',
  nodes_found: 'Compatible nodes found',
  node_selected: 'Node selected',
  prompt_delivered: 'Encrypted prompt delivered',
  inference_started: 'Ollama inference started',
  result_returned: 'Result returned',
  result_verified: 'Result verified',
  node_paid: 'Node paid',
  refunded: 'Unused NOET refunded',
  finalized: 'Task finalized',
  failed: 'Task failed',
  cancelled: 'Task cancelled',
};

export const NetworkStatsSchema = z.object({
  total_nodes: z.number(),
  online_nodes: z.number(),
  total_tasks: z.number(),
  completed_tasks: z.number(),
  total_noet_supply: z.number(),
  block_height: z.number(),
});

export type NetworkStats = z.infer<typeof NetworkStatsSchema>;

export const P2P_MESSAGE_TYPES = [
  'HELLO',
  'BLOCK_PROPOSED',
  'BLOCK_ATTEST',
  'BLOCK_FINAL',
  'TX_GOSSIP',
  'CHAIN_REQUEST',
  'CHAIN_RESPONSE',
  'TASK_OFFER',
  'TASK_ACCEPT',
  'TASK_RESULT',
  'NODE_ANNOUNCE',
  'PEER_LIST',
] as const;

export type P2PMessageType = (typeof P2P_MESSAGE_TYPES)[number];

export const P2PMessageSchema = z.object({
  type: z.enum(P2P_MESSAGE_TYPES),
  message_id: z.string().uuid(),
  timestamp: z.number().int(),
  sender_id: z.string(),
  payload: z.record(z.unknown()),
  signature: z.string(),
});

export type P2PMessage = z.infer<typeof P2PMessageSchema>;

export const TaskOfferSchema = z.object({
  task_id: z.string().uuid(),
  prompt_hash: z.string(),
  model: z.string(),
  max_output_tokens: z.number(),
  verification_level: VerificationLevelSchema,
  processing_mode: ProcessingModeSchema,
  estimated_price: z.number(),
  user_address: z.string(),
  encrypted_prompt: z.object({
    ciphertext: z.string(),
    nonce: z.string(),
    ephemeralPublicKey: z.string(),
  }).optional(),
  assigned_nodes: z.array(z.string()).default([]),
});
