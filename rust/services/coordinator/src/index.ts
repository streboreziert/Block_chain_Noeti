import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  verifyPayloadSignature,
  encryptForRecipient,
  deriveNodeId,
  canonicalMessage,
} from '@noetis/crypto';
import { WSMessageSchema, NodeRegistrationSchema, type WSMessage } from '@noetis/protocol';
import { createPool, migrate, NodeRepository, ProgressRepository, TaskRepository } from '@noetis/database';
import { decomposeSubtasks } from '@noetis/scheduler';

const PORT = Number(process.env.PORT ?? 3002);
const WS_PATH = process.env.WS_PATH ?? '/ws';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const VALIDATOR_URL = process.env.VALIDATOR_URL ?? 'http://localhost:3003';
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 60_000);
const INTERNAL_DISPATCH_TOKEN = process.env.INTERNAL_DISPATCH_TOKEN ?? '';

const pool = createPool();
const nodeRepo = new NodeRepository(pool);
const progress = new ProgressRepository(pool);
const tasks = new TaskRepository(pool);
const redis = new Redis(REDIS_URL);

interface ConnectedNode {
  ws: WebSocket;
  nodeId: string;
  publicKey: string;
  walletAddress: string;
  registration: Record<string, unknown>;
  activeTasks: Set<string>;
}

const nodes = new Map<string, ConnectedNode>();
const pendingTasks = new Map<string, Record<string, unknown>>();

const app = express();
app.use(express.json({ limit: '512kb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'noetis-coordinator' }));

app.post('/internal/dispatch', async (req, res) => {
  if (INTERNAL_DISPATCH_TOKEN) {
    const token = req.headers['x-noetis-internal-token'];
    if (token !== INTERNAL_DISPATCH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized internal dispatch' });
    }
  }
  const data = req.body as Record<string, unknown>;
  pendingTasks.set(data.task_id as string, data);

  const processingMode = data.processing_mode as string;
  let prompts: string[] = [data.prompt as string];
  if (processingMode === 'subtask') {
    prompts = decomposeSubtasks(data.prompt as string);
  }

  const assignedNodes = data.nodes as Array<{ node_id: string; public_key: string }>;
  await progress.addEvent(data.task_id as string, 'prompt_delivered');

  for (let i = 0; i < assignedNodes.length; i++) {
    const nodeInfo = assignedNodes[i];
    const conn = nodes.get(nodeInfo.node_id);
    if (!conn) continue;

    const promptText = prompts[i] ?? prompts[0];
    const encrypted = encryptForRecipient(
      JSON.stringify({
        task_id: data.task_id,
        prompt: promptText,
        model: data.model,
        max_output_tokens: data.max_output_tokens,
        subtask_index: i,
        subtask_total: assignedNodes.length,
      }),
      (nodeInfo as { box_public_key?: string }).box_public_key ?? nodeInfo.public_key
    );

    await sendToNode(conn, 'TASK_PAYLOAD', conn.publicKey, {
      task_id: data.task_id,
      encrypted,
      model: data.model,
      estimated_reward: (data.estimated_price as number) / assignedNodes.length,
    });
    conn.activeTasks.add(data.task_id as string);
  }

  res.json({ dispatched: true });
});

function sendToNode(conn: ConnectedNode, type: WSMessage['type'], sender: string, payload: Record<string, unknown>): Promise<void> {
  const msg: WSMessage = {
    type,
    message_id: randomUUID(),
    timestamp: Date.now(),
    sender,
    payload,
    signature: 'coordinator',
  };
  conn.ws.send(JSON.stringify(msg));
  return Promise.resolve();
}

async function handleMessage(ws: WebSocket, raw: string): Promise<void> {
  let parsed: WSMessage;
  try {
    parsed = WSMessageSchema.parse(JSON.parse(raw));
  } catch {
    ws.send(JSON.stringify({ type: 'ERROR', payload: { error: 'Invalid message schema' } }));
    return;
  }

  if (parsed.type === 'NODE_REGISTER') {
    const reg = NodeRegistrationSchema.parse(parsed.payload);
    const valid = await verifyPayloadSignature(parsed.payload as Record<string, unknown>, parsed.signature, reg.public_key);
    if (!valid) {
      ws.send(JSON.stringify({ type: 'ERROR', payload: { error: 'Invalid registration signature' } }));
      return;
    }

    const nodeId = deriveNodeId(reg.public_key);
    const conn: ConnectedNode = {
      ws,
      nodeId,
      publicKey: reg.public_key,
      walletAddress: reg.wallet_address,
      registration: { ...reg, node_id: nodeId },
      activeTasks: new Set(),
    };
    nodes.set(nodeId, conn);
    await nodeRepo.upsertNode(conn.registration);
    await redis.set(`node:online:${nodeId}`, '1', 'EX', Math.ceil(HEARTBEAT_TIMEOUT_MS / 1000));

    const reply: WSMessage = {
      type: 'REGISTERED',
      message_id: randomUUID(),
      timestamp: Date.now(),
      sender: 'coordinator',
      payload: { node_id: nodeId, status: 'registered' },
      signature: 'coordinator',
    };
    ws.send(JSON.stringify(reply));
    return;
  }

  const conn = [...nodes.values()].find((n) => n.ws === ws);
  if (!conn) return;

  if (parsed.type === 'NODE_HEARTBEAT') {
    await nodeRepo.upsertNode({ ...conn.registration, status: parsed.payload.status ?? 'available' });
    await redis.set(`node:online:${conn.nodeId}`, '1', 'EX', Math.ceil(HEARTBEAT_TIMEOUT_MS / 1000));
    return;
  }

  if (parsed.type === 'TASK_ACCEPT') {
    await progress.addEvent(parsed.payload.task_id as string, 'inference_started');
    return;
  }

  if (parsed.type === 'TASK_PROGRESS') {
    return;
  }

  if (parsed.type === 'TASK_RESULT') {
    const taskId = parsed.payload.task_id as string;
    await progress.addEvent(taskId, 'result_returned');
    conn.activeTasks.delete(taskId);

    await fetch(`${VALIDATOR_URL}/internal/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: taskId,
        node_id: conn.nodeId,
        node_address: conn.walletAddress,
        result: parsed.payload.result,
        result_hash: parsed.payload.result_hash,
        signature: parsed.signature,
        public_key: conn.publicKey,
        duration_ms: parsed.payload.duration_ms,
        input_tokens: parsed.payload.input_tokens,
        output_tokens: parsed.payload.output_tokens,
      }),
    });
    return;
  }
}

async function main() {
  await migrate(pool);
  const server = app.listen(PORT, () => console.log(`Coordinator HTTP on :${PORT}`));
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => handleMessage(ws, data.toString()).catch(console.error));
    ws.on('close', () => {
      for (const [id, conn] of nodes.entries()) {
        if (conn.ws === ws) {
          nodes.delete(id);
          nodeRepo.upsertNode({ ...conn.registration, status: 'offline' }).catch(console.error);
        }
      }
    });
  });

  setInterval(async () => {
    const all = await nodeRepo.listNodes();
    for (const n of all) {
      const last = new Date(n.last_heartbeat as string).getTime();
      if (Date.now() - last > HEARTBEAT_TIMEOUT_MS) {
        await nodeRepo.upsertNode({ ...(n.metadata as object), node_id: n.node_id, status: 'offline' });
      }
    }
  }, 30_000);
}

main().catch(console.error);
