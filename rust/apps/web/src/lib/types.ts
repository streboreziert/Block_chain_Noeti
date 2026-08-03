export const API = process.env.NEXT_PUBLIC_API_URL ?? '';

export interface Wallet {
  address: string;
  public_key: string;
  private_key?: string;
  balance?: number;
  chain_verified?: boolean;
}

export interface TaskProgress {
  status: string;
  message: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  status: string;
  estimated_price: number;
  model?: string;
  prompt_hash?: string;
  created_at?: string;
  progress?: TaskProgress[];
}

export interface NodeSettings {
  inputPrice: number;
  outputPrice: number;
  maxParallelTasks: number;
  minTaskPayment: number;
  acceptsRedundant: boolean;
  enabledModels: string;
  ollamaUrl: string;
  coordinatorUrl: string;
  p2pBootstrap: string;
}

export const DEFAULT_NODE_SETTINGS: NodeSettings = {
  inputPrice: 0.00001,
  outputPrice: 0.00003,
  maxParallelTasks: 2,
  minTaskPayment: 0,
  acceptsRedundant: true,
  enabledModels: '',
  ollamaUrl: 'http://localhost:11434',
  coordinatorUrl: 'ws://localhost:3002/ws',
  p2pBootstrap: 'ws://localhost:4001',
};

export const PROGRESS_LABELS: Record<string, string> = {
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
};

export const ALL_STEPS = [
  'created', 'price_estimated', 'escrow_locked', 'nodes_found', 'node_selected',
  'prompt_delivered', 'inference_started', 'result_returned', 'result_verified',
  'node_paid', 'refunded', 'finalized',
];
