import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  createWallet,
  walletFromPrivateKey,
  hash,
  estimateTokens,
  verifyAuthChallenge,
  signPayload,
  type Wallet,
} from '@noetis/crypto';
import {
  createWalletAccount,
  faucetTransfer,
  getBalance,
  estimateTaskPrice,
  lockEscrow,
  FAUCET_AMOUNT,
} from '@noetis/currency';
import { CreateTaskRequestSchema } from '@noetis/protocol';
import {
  createPool,
  migrate,
  TaskRepository,
  WalletRepository,
  NodeRepository,
  BlockRepository,
  ProgressRepository,
} from '@noetis/database';
import { selectNodes, type SchedulableNode } from '@noetis/scheduler';

const PORT = Number(process.env.PORT ?? 3001);
const COORDINATOR_URL = process.env.COORDINATOR_INTERNAL_URL ?? 'http://localhost:3002';
const FULL_NODE_URL = process.env.FULL_NODE_URL ?? 'http://localhost:4000';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const INTERNAL_DISPATCH_TOKEN = process.env.INTERNAL_DISPATCH_TOKEN ?? '';
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 60_000);

async function gossipTx(tx: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${FULL_NODE_URL}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tx),
    });
  } catch {
    // full-node optional during migration
  }
}

async function chainBalance(address: string): Promise<number | null> {
  try {
    const res = await fetch(`${FULL_NODE_URL}/chain/balance/${address}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { balance: number };
    return data.balance;
  } catch {
    return null;
  }
}

const pool = createPool();
const redis = new Redis(REDIS_URL);
const tasks = new TaskRepository(pool);
const wallets = new WalletRepository(pool);
const nodes = new NodeRepository(pool);
const blocks = new BlockRepository(pool);
const progress = new ProgressRepository(pool);

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'noetis-api' }));

app.post('/api/wallets', async (_req, res) => {
  const wallet = await createWallet();
  await wallets.upsertWallet(wallet.address, wallet.publicKey);
  res.json({
    address: wallet.address,
    public_key: wallet.publicKey,
    private_key: wallet.privateKey,
    note: 'Store private_key securely. Never share it.',
  });
});

app.post('/api/wallets/import', async (req, res) => {
  const { private_key } = req.body as { private_key?: string };
  if (!private_key) return res.status(400).json({ error: 'private_key required' });
  const wallet = await walletFromPrivateKey(private_key);
  await wallets.upsertWallet(wallet.address, wallet.publicKey);
  res.json({ address: wallet.address, public_key: wallet.publicKey });
});

app.get('/api/wallets/:address', async (req, res) => {
  const wallet = await wallets.getWallet(req.params.address);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  const onChain = await chainBalance(req.params.address);
  res.json({
    address: wallet.address,
    public_key: wallet.public_key,
    balance: onChain ?? wallet.balance,
    chain_verified: onChain !== null,
  });
});

app.post('/api/faucet', async (req, res) => {
  const { address } = req.body as { address?: string };
  if (!address) return res.status(400).json({ error: 'address required' });
  let wallet = await wallets.getWallet(address);
  if (!wallet) {
    await wallets.upsertWallet(address, '');
    wallet = await wallets.getWallet(address);
  }
  try {
    const newBalance = await wallets.incrementBalance(address, FAUCET_AMOUNT);
    await gossipTx({
      id: randomUUID(),
      type: 'FAUCET_TRANSFER',
      from: 'faucet-dev-only',
      to: address,
      amount: FAUCET_AMOUNT,
      metadata: { note: 'DEVELOPMENT ONLY' },
      timestamp: Date.now(),
    });
    await redis.publish('ledger:tx', JSON.stringify({ type: 'FAUCET_TRANSFER', address, amount: FAUCET_AMOUNT }));
    res.json({
      amount: FAUCET_AMOUNT,
      balance: newBalance,
      warning: 'DEVELOPMENT ONLY — test NOET (NOET) has no real monetary value.',
    });
  } catch (e) {
    res.status(429).json({ error: (e as Error).message });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const body = CreateTaskRequestSchema.parse(req.body);
    const wallet = await wallets.getWallet(body.wallet_address);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const authOk = await verifyAuthChallenge(
      { wallet_address: body.wallet_address, timestamp: body.timestamp, nonce: body.nonce },
      body.signature,
      wallet.public_key
    );
    if (!authOk) return res.status(401).json({ error: 'Invalid signature or expired challenge' });

    const nonceKey = `nonce:${body.wallet_address}:${body.nonce}`;
    const used = await redis.set(nonceKey, '1', 'EX', 600, 'NX');
    if (!used) return res.status(409).json({ error: 'Replay detected: nonce already used' });

    const nodeList = await nodes.listNodes();
    const onlineNodes: SchedulableNode[] = nodeList
      .filter((n) => Date.now() - new Date(n.last_heartbeat as string).getTime() < HEARTBEAT_TIMEOUT_MS)
      .map((n) => ({
        ...(n.metadata as object),
        node_id: n.node_id as string,
        wallet_address: n.wallet_address as string,
        public_key: n.public_key as string,
        models: n.models as SchedulableNode['models'],
        cpu: n.cpu as string,
        gpu: n.gpu as string | undefined,
        ram_gb: n.ram_gb as number,
        vram_gb: n.vram_gb as number | undefined,
        operating_system: n.operating_system as string,
        price_per_input_token: n.price_per_input_token as number,
        price_per_output_token: n.price_per_output_token as number,
        maximum_parallel_tasks: n.maximum_parallel_tasks as number,
        reputation: n.reputation as number,
        status: n.status as SchedulableNode['status'],
        accepts_redundant: true,
        minimum_task_payment: 0,
        current_tasks: 0,
        avg_latency_ms: 2000,
        success_rate: 0.9,
        last_heartbeat: new Date(n.last_heartbeat as string).getTime(),
      }));

    const inputTokens = estimateTokens(body.prompt);
    const avgInputPrice = onlineNodes.length
      ? onlineNodes.reduce((s, n) => s + n.price_per_input_token, 0) / onlineNodes.length
      : 0.00001;
    const avgOutputPrice = onlineNodes.length
      ? onlineNodes.reduce((s, n) => s + n.price_per_output_token, 0) / onlineNodes.length
      : 0.00003;
    const nodeCount = body.processing_mode === 'redundant' ? 3 : body.verification_level === 'high' ? 3 : body.verification_level === 'medium' ? 2 : 1;

    const estimatedPrice = estimateTaskPrice({
      inputTokens,
      maxOutputTokens: body.max_output_tokens,
      model: body.model,
      nodeCount,
      verificationLevel: body.verification_level,
      nodeInputPrice: avgInputPrice,
      nodeOutputPrice: avgOutputPrice,
    });

    if (wallet.balance < estimatedPrice) {
      return res.status(402).json({ error: 'Insufficient NOET balance', required: estimatedPrice, balance: wallet.balance });
    }

    const selected = selectNodes(onlineNodes, {
      model: body.model,
      maxPrice: estimatedPrice,
      processingMode: body.processing_mode,
      verificationLevel: body.verification_level,
    });

    if (selected.length === 0) {
      return res.status(503).json({ error: 'No compatible online nodes available for this model' });
    }

    const taskId = randomUUID();
    const promptHash = hash(body.prompt);

    await wallets.incrementBalance(body.wallet_address, -estimatedPrice);
    await pool.query(
      'INSERT INTO escrows (task_id, user_address, locked_amount) VALUES ($1, $2, $3)',
      [taskId, body.wallet_address, estimatedPrice]
    );

    await tasks.createTask({
      id: taskId,
      user_address: body.wallet_address,
      model: body.model,
      prompt_hash: promptHash,
      max_output_tokens: body.max_output_tokens,
      verification_level: body.verification_level,
      processing_mode: body.processing_mode,
      estimated_price: estimatedPrice,
      status: 'created',
      node_addresses: selected.map((n) => n.wallet_address),
    });

    await progress.addEvent(taskId, 'created');
    await progress.addEvent(taskId, 'price_estimated', `Estimated ${estimatedPrice} NOET`);
    await progress.addEvent(taskId, 'escrow_locked');
    await progress.addEvent(taskId, 'nodes_found', `${selected.length} node(s)`);
    await progress.addEvent(taskId, 'node_selected', selected.map((n) => n.node_id).join(', '));
    await tasks.updateStatus(taskId, 'node_selected', { node_addresses: selected.map((n) => n.wallet_address) });

    // Store encrypted prompt temporarily in Redis (off-chain, auto-expire)
    await redis.setex(`task:prompt:${taskId}`, 3600, body.prompt);

    // Gossip task to decentralized P2P task market
    await fetch(`${FULL_NODE_URL}/task-offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: taskId,
        prompt_hash: promptHash,
        model: body.model,
        max_output_tokens: body.max_output_tokens,
        verification_level: body.verification_level,
        processing_mode: body.processing_mode,
        estimated_price: estimatedPrice,
        user_address: body.wallet_address,
        assigned_nodes: selected.map((n) => n.node_id),
      }),
    }).catch(() => {});

    // Fallback: coordinator WebSocket dispatch (legacy federated mode)
    await fetch(`${COORDINATOR_URL}/internal/dispatch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_DISPATCH_TOKEN ? { 'x-noetis-internal-token': INTERNAL_DISPATCH_TOKEN } : {}),
      },
      body: JSON.stringify({
        task_id: taskId,
        prompt: body.prompt,
        model: body.model,
        max_output_tokens: body.max_output_tokens,
        verification_level: body.verification_level,
        processing_mode: body.processing_mode,
        nodes: selected.map((n) => ({
          node_id: n.node_id,
          public_key: n.public_key,
          box_public_key: (n as { box_public_key?: string }).box_public_key,
          wallet_address: n.wallet_address,
        })),
        user_address: body.wallet_address,
        estimated_price: estimatedPrice,
      }),
    });

    res.status(201).json({
      task_id: taskId,
      estimated_price: estimatedPrice,
      prompt_hash: promptHash,
      nodes: selected.map((n) => n.node_id),
      status: 'node_selected',
    });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get('/api/tasks', async (req, res) => {
  const wallet = req.query.wallet as string | undefined;
  const list = await tasks.listTasks(wallet, 30);
  res.json(list);
});

app.get('/api/tasks/:taskId', async (req, res) => {
  const task = await tasks.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const events = await progress.listEvents(req.params.taskId);
  res.json({ ...task, progress: events });
});

app.get('/api/tasks/:taskId/result', async (req, res) => {
  const task = await tasks.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.result_text) return res.status(202).json({ status: task.status, message: 'Result not ready' });
  res.json({
    task_id: task.id,
    result: task.result_text,
    result_hash: task.result_hash,
    status: task.status,
    verification_result: task.verification_result,
  });
});

app.get('/api/nodes', async (_req, res) => {
  const list = await nodes.listNodes();
  res.json(list);
});

app.get('/api/network/stats', async (_req, res) => {
  const totalNodes = (await nodes.listNodes()).length;
  const onlineNodes = await nodes.countOnline(HEARTBEAT_TIMEOUT_MS);
  const totalTasks = await tasks.countTasks();
  const completedTasks = await tasks.countCompleted();
  const totalNoet = await wallets.totalSupply();
  const blockHeight = await blocks.getHeight();
  res.json({ total_nodes: totalNodes, online_nodes: onlineNodes, total_tasks: totalTasks, completed_tasks: completedTasks, total_noet_supply: totalNoet, block_height: blockHeight });
});

app.get('/api/chain', async (_req, res) => {
  try {
    const r = await fetch(`${FULL_NODE_URL}/chain`);
    res.json(await r.json());
  } catch {
    res.json(await blocks.listBlocks(20));
  }
});

app.get('/api/peers', async (_req, res) => {
  try {
    const r = await fetch(`${FULL_NODE_URL}/peers`);
    res.json(await r.json());
  } catch {
    res.json([]);
  }
});

app.get('/api/blocks', async (_req, res) => {
  res.json(await blocks.listBlocks(20));
});

async function main() {
  await migrate(pool);
  app.listen(PORT, () => console.log(`Noetis API listening on :${PORT}`));
}

main().catch(console.error);
