import { describe, it, expect } from 'vitest';
import { selectNodes, decomposeSubtasks, type SchedulableNode } from './index.js';

const baseNode = (id: string, reputation: number, price: number): SchedulableNode => ({
  node_id: id,
  wallet_address: `noet1${id}`,
  models: [{ name: 'llama3.2:3b', model_hash: 'abc', context_length: 8192 }],
  cpu: 'Apple M1',
  ram_gb: 16,
  operating_system: 'darwin',
  price_per_input_token: price,
  price_per_output_token: price * 3,
  maximum_parallel_tasks: 2,
  reputation,
  status: 'available',
  public_key: id,
  accepts_redundant: true,
  minimum_task_payment: 0,
  current_tasks: 0,
  avg_latency_ms: 1000,
  success_rate: 0.95,
  last_heartbeat: Date.now(),
});

describe('scheduler', () => {
  it('selects weighted nodes', () => {
    const nodes = [baseNode('a', 90, 0.00001), baseNode('b', 50, 0.000005), baseNode('c', 70, 0.00002)];
    const selected = selectNodes(nodes, {
      model: 'llama3.2:3b',
      maxPrice: 100,
      processingMode: 'single',
      verificationLevel: 'low',
    });
    expect(selected.length).toBe(1);
  });

  it('decomposes subtasks', () => {
    const subtasks = decomposeSubtasks('Compare A\nAnalyze B\nReview C');
    expect(subtasks.length).toBeGreaterThan(1);
  });
});
