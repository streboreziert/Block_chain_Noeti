import express from 'express';
import { randomUUID } from 'node:crypto';
import { hash, verifyPayloadSignature, createWallet } from '@noetis/crypto';
import { VALIDATOR_REWARD_RATE, NETWORK_FEE_RATE } from '@noetis/currency';
import {
  createBlockchain,
  produceBlock,
  queueTransaction,
  queueSettlement,
  ProofOfAuthorityConsensus,
  type BlockchainState,
} from '@noetis/blockchain';
import {
  createPool,
  migrate,
  TaskRepository,
  WalletRepository,
  NodeRepository,
  BlockRepository,
  ProgressRepository,
} from '@noetis/database';

const PORT = Number(process.env.PORT ?? 3003);

const pool = createPool();
const tasks = new TaskRepository(pool);
const wallets = new WalletRepository(pool);
const nodes = new NodeRepository(pool);
const blocks = new BlockRepository(pool);
const progress = new ProgressRepository(pool);

let chainState: BlockchainState;
let validatorWallet: Awaited<ReturnType<typeof createWallet>>;

const taskResults = new Map<string, Array<Record<string, unknown>>>();

function semanticSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

function updateReputation(current: number, success: boolean, durationMs: number): number {
  const delta = success ? 2 : -5;
  const speedBonus = durationMs < 5000 ? 0.5 : durationMs > 30000 ? -0.5 : 0;
  return Math.max(0, Math.min(100, current + delta + speedBonus));
}

async function finalizeTask(taskId: string, resultText: string, verification: Record<string, unknown>): Promise<void> {
  const task = await tasks.getTask(taskId);
  if (!task || task.status === 'finalized') return;

  const resultHash = hash(resultText);
  await tasks.updateStatus(taskId, 'result_verified', {
    result_hash: resultHash,
    result_text: resultText,
    verification_result: verification,
  });
  await progress.addEvent(taskId, 'result_verified');

  const escrowRes = await pool.query('SELECT * FROM escrows WHERE task_id = $1', [taskId]);
  const escrow = escrowRes.rows[0];
  if (!escrow) return;

  const nodePayment = escrow.locked_amount * (1 - NETWORK_FEE_RATE - VALIDATOR_REWARD_RATE);
  const validatorPayment = escrow.locked_amount * VALIDATOR_REWARD_RATE;
  const networkFee = escrow.locked_amount * NETWORK_FEE_RATE;

  const nodeAddress = (verification.winning_node_address as string) ?? task.node_addresses[0];
  if (nodeAddress) {
    await wallets.incrementBalance(nodeAddress, nodePayment);
    await progress.addEvent(taskId, 'node_paid', `${nodePayment} NOET to ${nodeAddress}`);
  }
  await wallets.incrementBalance(validatorWallet.address, validatorPayment);

  const refund = escrow.locked_amount - nodePayment - validatorPayment - networkFee;
  if (refund > 0.000001) {
    await wallets.incrementBalance(task.user_address, refund);
    await progress.addEvent(taskId, 'refunded', `${refund} NOET returned`);
  }

  await pool.query("UPDATE escrows SET status = 'settled', spent_amount = $2 WHERE task_id = $1", [taskId, nodePayment + validatorPayment + networkFee]);
  await tasks.updateStatus(taskId, 'finalized', { actual_price: nodePayment + validatorPayment + networkFee });
  await progress.addEvent(taskId, 'finalized');

  queueTransaction(chainState, {
    id: randomUUID(),
    type: 'RESULT_VERIFIED',
    from: null,
    to: nodeAddress,
    amount: nodePayment,
    metadata: { task_id: taskId, result_hash: resultHash },
    timestamp: Date.now(),
  });
  queueSettlement(chainState, {
    task_id: taskId,
    user_address: task.user_address,
    node_address: nodeAddress,
    prompt_hash: task.prompt_hash,
    result_hash: resultHash,
    amount_paid: nodePayment,
  });

  const block = await produceBlock(chainState, chainState.validators[0]);
  await blocks.saveBlock(block as unknown as Record<string, unknown>);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'noetis-validator' }));

app.post('/internal/verify', async (req, res) => {
  const data = req.body as Record<string, unknown>;
  const taskId = data.task_id as string;
  const result = data.result as string;
  const resultHash = data.result_hash as string;
  const publicKey = data.public_key as string;

  if (hash(result) !== resultHash) {
    return res.status(400).json({ error: 'Result hash mismatch' });
  }

  const payload = { task_id: taskId, result, result_hash: resultHash, duration_ms: data.duration_ms };
  const sigValid = await verifyPayloadSignature(payload, data.signature as string, publicKey);
  if (!sigValid) return res.status(400).json({ error: 'Invalid result signature' });

  if (!result || result.trim().length === 0) {
    const nodeId = data.node_id as string;
    const nodeList = await nodes.listNodes();
    const node = nodeList.find((n) => n.node_id === nodeId);
    if (node) {
      await nodes.updateReputation(nodeId, updateReputation(node.reputation as number, false, data.duration_ms as number));
    }
    return res.status(400).json({ error: 'Empty result rejected' });
  }

  const existing = taskResults.get(taskId) ?? [];
  existing.push(data);
  taskResults.set(taskId, existing);

  const task = await tasks.getTask(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const requiredResults = task.verification_level === 'high' ? 3 : task.verification_level === 'medium' ? 2 : 1;

  if (existing.length < requiredResults && task.processing_mode !== 'single') {
    return res.json({ status: 'pending', received: existing.length, required: requiredResults });
  }

  let finalResult = result;
  let verification: Record<string, unknown> = { method: 'signature_and_hash', nodes: existing.length };

  if (existing.length > 1) {
    const results = existing.map((r) => r.result as string);
    const exactMatch = results.every((r) => r === results[0]);
    if (exactMatch) {
      verification.method = 'exact_match';
      finalResult = results[0];
    } else {
      let best = results[0];
      let bestScore = 0;
      for (const candidate of results) {
        const scores = results.map((r) => semanticSimilarity(candidate, r));
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        if (avg > bestScore) {
          bestScore = avg;
          best = candidate;
        }
      }
      verification.method = 'semantic_consensus';
      verification.similarity = bestScore;
      if (bestScore < 0.3) {
        return res.status(422).json({ error: 'Results failed consensus verification' });
      }
      finalResult = best;
    }
  }

  verification.winning_node_address = data.node_address;
  verification.duration_ms = data.duration_ms;

  const nodeId = data.node_id as string;
  const nodeList = await nodes.listNodes();
  const node = nodeList.find((n) => n.node_id === nodeId);
  if (node) {
    await nodes.updateReputation(nodeId, updateReputation(node.reputation as number, true, data.duration_ms as number));
  }

  await finalizeTask(taskId, finalResult, verification);
  taskResults.delete(taskId);
  res.json({ status: 'verified', task_id: taskId });
});

async function main() {
  await migrate(pool);
  validatorWallet = await createWallet();
  await wallets.upsertWallet(validatorWallet.address, validatorWallet.publicKey);
  chainState = await createBlockchain([{ id: 'validator-1', publicKey: validatorWallet.publicKey, wallet: validatorWallet }]);
  const consensus = new ProofOfAuthorityConsensus(chainState.validators[0]);
  console.log('Validator wallet:', validatorWallet.address);
  app.listen(PORT, () => console.log(`Validator listening on :${PORT}`));
}

main().catch(console.error);
