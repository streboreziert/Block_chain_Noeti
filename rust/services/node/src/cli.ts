import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cpus, totalmem, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Command } from 'commander';
import {
  createWallet,
  walletFromPrivateKey,
  signPayload,
  decryptFromSender,
  hash,
  deriveNodeId,
  type Wallet,
} from '@noetis/crypto';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { NODE_STAKE_AMOUNT } from '@noetis/currency';
import { OllamaClient } from '@noetis/ollama-client';
import { WSMessageSchema, type WSMessage } from '@noetis/protocol';
import { GossipNetwork } from '@noetis/p2p';

interface NodeConfig {
  coordinator: string;
  p2pBootstrap: string;
  p2pPort: number;
  walletPath: string;
  ollamaUrl: string;
  pricePerInputToken: number;
  pricePerOutputToken: number;
  maxParallelTasks: number;
  acceptsRedundant: boolean;
  minimumTaskPayment: number;
  enabledModels?: string[];
}

interface NodeStats {
  completed: number;
  failed: number;
  earned: number;
  uptimeStart: number;
}

function detectGpu(): string | undefined {
  try {
    if (platform() === 'darwin') {
      return execSync('system_profiler SPDisplaysDataType 2>/dev/null | head -5', { encoding: 'utf8' }).split('\n')[1]?.trim();
    }
    return execSync('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null', { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function loadWallet(path: string): Promise<Wallet> {
  if (!existsSync(path)) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return createWallet().then((w) => {
      writeFileSync(path, JSON.stringify({
        address: w.address,
        publicKey: w.publicKey,
        privateKey: w.privateKey,
        boxPublicKey: w.boxPublicKey,
        boxSecretKey: bytesToHex(w.boxSecretKey),
      }, null, 2));
      console.log(`Created new wallet at ${path}: ${w.address}`);
      return w;
    });
  }
  const data = JSON.parse(readFileSync(path, 'utf8')) as { privateKey: string; boxSecretKey?: string };
  return walletFromPrivateKey(data.privateKey, data.boxSecretKey);
}

function toWsUrl(coordinator: string): string {
  if (coordinator.startsWith('ws://') || coordinator.startsWith('wss://')) return coordinator;
  const url = new URL(coordinator);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.endsWith('/ws') ? url.pathname : `${url.pathname.replace(/\/$/, '')}/ws`;
  return url.toString();
}

async function runNode(config: NodeConfig): Promise<void> {
  const wallet = await loadWallet(config.walletPath);
  const nodeId = deriveNodeId(wallet.publicKey);
  const ollama = new OllamaClient(config.ollamaUrl);
  const stats: NodeStats = { completed: 0, failed: 0, earned: 0, uptimeStart: Date.now() };
  let activeTasks = 0;
  let ws: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  async function register(socket: WebSocket): Promise<void> {
    const ollamaOk = await ollama.healthCheck();
    if (!ollamaOk) console.warn('WARNING: Ollama not reachable at', config.ollamaUrl);

    let models = await ollama.listModels();
    if (config.enabledModels?.length) {
      models = models.filter((m) => config.enabledModels!.some((e) => m.name.includes(e)));
    }
    if (models.length === 0) {
      console.warn('No Ollama models found. Pull a model: ollama pull llama3.2:3b');
    }

    const payload = {
      node_id: nodeId,
      wallet_address: wallet.address,
      public_key: wallet.publicKey,
      box_public_key: wallet.boxPublicKey,
      models,
      cpu: cpus()[0]?.model ?? 'unknown',
      gpu: detectGpu(),
      ram_gb: Math.round(totalmem() / 1024 ** 3),
      operating_system: platform(),
      price_per_input_token: config.pricePerInputToken,
      price_per_output_token: config.pricePerOutputToken,
      maximum_parallel_tasks: config.maxParallelTasks,
      reputation: 0,
      status: 'available',
      accepts_redundant: config.acceptsRedundant,
      minimum_task_payment: config.minimumTaskPayment,
    };

    const signature = await signPayload(payload, wallet);
    const msg: WSMessage = {
      type: 'NODE_REGISTER',
      message_id: randomUUID(),
      timestamp: Date.now(),
      sender: wallet.publicKey,
      payload,
      signature,
    };
    socket.send(JSON.stringify(msg));
    console.log(`Registered node ${nodeId} with ${models.length} model(s)`);
  }

  async function processTask(payload: Record<string, unknown>): Promise<void> {
    const taskId = payload.task_id as string;
    const encrypted = payload.encrypted as { ciphertext: string; nonce: string; ephemeralPublicKey: string };
    const model = payload.model as string;

    activeTasks++;
    try {
      const decrypted = decryptFromSender(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.ephemeralPublicKey,
        wallet.boxSecretKey
      );
      const taskData = JSON.parse(decrypted) as {
        prompt: string;
        max_output_tokens: number;
      };

      // Prompt is passed ONLY as data to Ollama — never executed as shell command
      const result = await ollama.generate({
        model,
        prompt: taskData.prompt,
        maxTokens: taskData.max_output_tokens,
        temperature: 0,
        seed: 42,
      });

      const resultHash = hash(result.response);
      const resultPayload = {
        task_id: taskId,
        result: result.response,
        result_hash: resultHash,
        duration_ms: result.durationMs,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
      };
      const signature = await signPayload(resultPayload, wallet);

      const msg: WSMessage = {
        type: 'TASK_RESULT',
        message_id: randomUUID(),
        timestamp: Date.now(),
        sender: wallet.publicKey,
        payload: resultPayload,
        signature,
      };
      ws?.send(JSON.stringify(msg));
      stats.completed++;
      stats.earned += (payload.estimated_reward as number) ?? 0;
      console.log(`Task ${taskId} completed in ${result.durationMs}ms`);
    } catch (e) {
      stats.failed++;
      console.error(`Task ${taskId} failed:`, (e as Error).message);
    } finally {
      activeTasks--;
    }
  }

  function connect(): void {
    const wsUrl = toWsUrl(config.coordinator);
    console.log(`Connecting to ${wsUrl}...`);
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log('Connected to coordinator');
      register(ws!).catch(console.error);
      if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    });

    ws.on('message', async (data) => {
      try {
        const msg = WSMessageSchema.parse(JSON.parse(data.toString()));
        if (msg.type === 'REGISTERED') {
          console.log('Registration confirmed:', msg.payload);
        }
        if (msg.type === 'TASK_PAYLOAD') {
          if (activeTasks >= config.maxParallelTasks) {
            console.log('At capacity, skipping task offer');
            return;
          }
          const acceptPayload = { task_id: msg.payload.task_id };
          ws!.send(JSON.stringify({
            type: 'TASK_ACCEPT',
            message_id: randomUUID(),
            timestamp: Date.now(),
            sender: wallet.publicKey,
            payload: acceptPayload,
            signature: await signPayload(acceptPayload, wallet),
          } satisfies WSMessage));
          await processTask(msg.payload);
        }
        if (msg.type === 'REWARD_CONFIRMED') {
          stats.earned += (msg.payload.amount as number) ?? 0;
        }
      } catch (e) {
        console.error('Message error:', e);
      }
    });

    ws.on('close', () => {
      console.log('Disconnected. Reconnecting in 5s...');
      ws = null;
      if (!reconnectTimer) {
        reconnectTimer = setInterval(() => connect(), 5000);
      }
    });

    ws.on('error', (err) => console.error('WebSocket error:', err.message));
  }

  connect();

  if (config.p2pBootstrap || config.p2pPort) {
    const publicHost = process.env.NOETIS_PUBLIC_HOST ?? process.env.PUBLIC_HOST;
    const gossip = new GossipNetwork(nodeId, wallet, config.p2pPort, publicHost);
    gossip.start(config.p2pBootstrap ? [config.p2pBootstrap] : []).then(async () => {
      console.log(`P2P gossip active on port ${config.p2pPort}`);
      const models = await ollama.listModels();
      await gossip.gossip('NODE_ANNOUNCE', {
        node_id: nodeId,
        wallet_address: wallet.address,
        public_key: wallet.publicKey,
        box_public_key: wallet.boxPublicKey,
        models,
        status: 'available',
      });
    }).catch(console.error);

    gossip.on('TASK_OFFER', async (msg) => {
      if (activeTasks >= config.maxParallelTasks) return;
      console.log(`P2P task offer: ${msg.payload.task_id}`);
      await gossip.gossip('TASK_ACCEPT', { task_id: msg.payload.task_id, node_id: nodeId });
    });
  }

  setInterval(async () => {
    if (ws?.readyState === WebSocket.OPEN) {
      const payload = {
        status: activeTasks >= config.maxParallelTasks ? 'busy' : 'available',
        active_tasks: activeTasks,
        completed: stats.completed,
        failed: stats.failed,
        earned: stats.earned,
        uptime_seconds: Math.floor((Date.now() - stats.uptimeStart) / 1000),
      };
      ws.send(JSON.stringify({
        type: 'NODE_HEARTBEAT',
        message_id: randomUUID(),
        timestamp: Date.now(),
        sender: wallet.publicKey,
        payload,
        signature: await signPayload(payload, wallet),
      } satisfies WSMessage));
    }
  }, 15_000);

  console.log(`Node stake requirement (prototype): ${NODE_STAKE_AMOUNT} NOET`);
  console.log(`Wallet: ${wallet.address}`);
}

const program = new Command();
program
  .name('noetis-node')
  .description('Noetis Compute processing node')
  .command('start')
  .option('--coordinator <url>', 'Coordinator URL', process.env.NOETIS_COORDINATOR_URL ?? 'ws://localhost:3002/ws')
  .option('--wallet <path>', 'Wallet file path', process.env.NOETIS_WALLET_PATH ?? './data/wallet.json')
  .option('--ollama <url>', 'Ollama URL', process.env.OLLAMA_URL ?? 'http://localhost:11434')
  .option('--input-price <n>', 'Price per input token', '0.00001')
  .option('--output-price <n>', 'Price per output token', '0.00003')
  .option('--max-tasks <n>', 'Max parallel tasks', '2')
  .option('--models <list>', 'Comma-separated enabled models')
  .option('--p2p-bootstrap <url>', 'P2P bootstrap peer ws:// URL', process.env.P2P_BOOTSTRAP ?? '')
  .option('--p2p-port <n>', 'P2P gossip listen port', process.env.P2P_PORT ?? '4010')
  .action(async (opts) => {
    await runNode({
      coordinator: opts.coordinator,
      p2pBootstrap: opts.p2pBootstrap,
      p2pPort: parseInt(opts.p2pPort, 10),
      walletPath: opts.wallet,
      ollamaUrl: opts.ollama,
      pricePerInputToken: parseFloat(opts.inputPrice),
      pricePerOutputToken: parseFloat(opts.outputPrice),
      maxParallelTasks: parseInt(opts.maxTasks, 10),
      acceptsRedundant: true,
      minimumTaskPayment: 0,
      enabledModels: opts.models?.split(',').map((s: string) => s.trim()),
    });
  });

program.parse();
