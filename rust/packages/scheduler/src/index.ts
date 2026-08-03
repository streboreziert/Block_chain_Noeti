import type { NodeRegistration, ProcessingMode, VerificationLevel } from '@noetis/protocol';

export interface SchedulableNode extends NodeRegistration {
  current_tasks: number;
  avg_latency_ms: number;
  success_rate: number;
  last_heartbeat: number;
}

export interface SelectionCriteria {
  model: string;
  maxPrice: number;
  processingMode: ProcessingMode;
  verificationLevel: VerificationLevel;
}

export interface NodeScore {
  node: SchedulableNode;
  score: number;
  breakdown: {
    reputation: number;
    availability: number;
    performance: number;
    price: number;
    latency: number;
  };
}

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 1;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export function scoreNode(node: SchedulableNode, allNodes: SchedulableNode[], maxPrice: number): NodeScore {
  const reputations = allNodes.map((n) => n.reputation);
  const latencies = allNodes.map((n) => n.avg_latency_ms || 1000);
  const prices = allNodes.map((n) => n.price_per_input_token + n.price_per_output_token);

  const reputationScore = normalize(node.reputation, Math.min(...reputations, 0), Math.max(...reputations, 100));
  const loadRatio = node.current_tasks / node.maximum_parallel_tasks;
  const availabilityScore = 1 - loadRatio;
  const performanceScore = normalize(node.success_rate, 0, 1);
  const nodePrice = node.price_per_input_token + node.price_per_output_token;
  const priceScore = 1 - normalize(nodePrice, Math.min(...prices), Math.max(...prices, maxPrice));
  const latencyScore = 1 - normalize(node.avg_latency_ms || 1000, Math.min(...latencies), Math.max(...latencies));

  const score =
    0.3 * reputationScore +
    0.25 * availabilityScore +
    0.2 * performanceScore +
    0.15 * priceScore +
    0.1 * latencyScore;

  return {
    node,
    score,
    breakdown: {
      reputation: reputationScore,
      availability: availabilityScore,
      performance: performanceScore,
      price: priceScore,
      latency: latencyScore,
    },
  };
}

export function filterCompatibleNodes(nodes: SchedulableNode[], criteria: SelectionCriteria): SchedulableNode[] {
  return nodes.filter((node) => {
    if (node.status !== 'available') return false;
    if (node.current_tasks >= node.maximum_parallel_tasks) return false;
    const hasModel = node.models.some((m) => m.name === criteria.model || m.name.startsWith(criteria.model));
    if (!hasModel) return false;
    const estPrice = node.price_per_input_token * 1000 + node.price_per_output_token * 512;
    if (estPrice > criteria.maxPrice) return false;
    if (criteria.processingMode === 'redundant' && !node.accepts_redundant) return false;
    return true;
  });
}

export function selectNodes(nodes: SchedulableNode[], criteria: SelectionCriteria): SchedulableNode[] {
  const compatible = filterCompatibleNodes(nodes, criteria);
  if (compatible.length === 0) return [];

  const scored = compatible
    .map((n) => scoreNode(n, compatible, criteria.maxPrice))
    .sort((a, b) => b.score - a.score);

  let count = 1;
  if (criteria.processingMode === 'redundant' || criteria.verificationLevel === 'high') {
    count = Math.min(3, scored.length);
  } else if (criteria.verificationLevel === 'medium') {
    count = Math.min(2, scored.length);
  }

  // Weighted selection: take top candidates but add slight randomness to avoid always picking #1
  const selected: SchedulableNode[] = [];
  const pool = [...scored];
  while (selected.length < count && pool.length > 0) {
    const weights = pool.map((_, i) => 1 / (i + 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    selected.push(pool[idx].node);
    pool.splice(idx, 1);
  }
  return selected;
}

export function decomposeSubtasks(prompt: string): string[] {
  const lines = prompt.split('\n').filter((l) => l.trim());
  if (lines.length >= 3) {
    return lines.slice(0, 5).map((l, i) => `Subtask ${i + 1}: ${l.trim()}`);
  }
  const chunks = Math.min(4, Math.max(2, Math.ceil(prompt.length / 500)));
  const size = Math.ceil(prompt.length / chunks);
  const subtasks: string[] = [];
  for (let i = 0; i < chunks; i++) {
    subtasks.push(`Subtask ${i + 1}: Process this section:\n${prompt.slice(i * size, (i + 1) * size)}`);
  }
  subtasks.push(`Subtask ${subtasks.length + 1}: Aggregate prior subtask results into a cohesive final answer for: ${prompt.slice(0, 200)}`);
  return subtasks;
}
