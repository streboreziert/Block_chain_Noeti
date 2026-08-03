import { signMessageDev } from './sign';
import { API, DEFAULT_NODE_SETTINGS, type NodeSettings, type Wallet } from './types';

export type ShellMode = 'user' | 'node';
export type LineCls = 'ok' | 'warn' | 'err' | 'info' | 'cmd' | 'out' | '';

export interface ShellLine {
  text: string;
  cls?: LineCls;
}

export interface ShellState {
  mode: ShellMode;
  userWallet: Wallet | null;
  nodeWallet: Wallet | null;
  nodeSettings: NodeSettings;
  lastTaskId: string | null;
  apiUrl: string;
}

export function loadShellState(): ShellState {
  if (typeof window === 'undefined') {
    return {
      mode: 'user',
      userWallet: null,
      nodeWallet: null,
      nodeSettings: DEFAULT_NODE_SETTINGS,
      lastTaskId: null,
      apiUrl: API,
    };
  }
  const user = localStorage.getItem('noetis_wallet');
  const node = localStorage.getItem('noetis_node_wallet');
  const settings = localStorage.getItem('noetis_node_settings');
  return {
    mode: 'user',
    userWallet: user ? JSON.parse(user) : null,
    nodeWallet: node ? JSON.parse(node) : null,
    nodeSettings: settings ? JSON.parse(settings) : DEFAULT_NODE_SETTINGS,
    lastTaskId: localStorage.getItem('noetis_last_task') ?? null,
    apiUrl: localStorage.getItem('noetis_api_url') ?? API,
  };
}

const INSTALL_SCRIPT =
  'https://raw.githubusercontent.com/streboreziert/Block_chain_Noeti/main/rust/scripts/install-linux.sh';

function hostFromWs(url: string): string {
  try {
    const u = new URL(url.replace(/^ws/i, 'http'));
    return u.hostname || 'YOUR_HOST';
  } catch {
    return 'YOUR_HOST';
  }
}

function linuxInstallLine(mode: 'compute' | 'full-node', s: NodeSettings, opts?: { seed?: boolean; run?: boolean }): string {
  const run = opts?.run ? ' --run' : '';
  if (mode === 'full-node') {
    if (opts?.seed) {
      return `curl -fsSL ${INSTALL_SCRIPT} | bash -s -- full-node --seed${run}`;
    }
    return `curl -fsSL ${INSTALL_SCRIPT} | bash -s -- full-node --bootstrap ${s.p2pBootstrap}${run}`;
  }
  return `curl -fsSL ${INSTALL_SCRIPT} | bash -s -- compute --bootstrap ${s.p2pBootstrap} --coordinator ${s.coordinatorUrl}${run}`;
}

export function saveWallet(wallet: Wallet, mode: ShellMode): void {
  const key = mode === 'node' ? 'noetis_node_wallet' : 'noetis_wallet';
  localStorage.setItem(key, JSON.stringify(wallet));
}

function parseArgs(input: string): { cmd: string; args: string[]; flags: Record<string, string> } {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(input)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  const flags: Record<string, string> = {};
  const args: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > -1) {
        flags[t.slice(2, eq)] = t.slice(eq + 1);
      } else if (tokens[i + 1] && !tokens[i + 1].startsWith('--')) {
        flags[t.slice(2)] = tokens[++i];
      } else {
        flags[t.slice(2)] = 'true';
      }
    } else {
      args.push(t);
    }
  }
  return { cmd: tokens[0]?.toLowerCase() ?? '', args, flags };
}

async function apiFetch(path: string, state: ShellState, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(`${state.apiUrl}${path}`, init);
  } catch {
    throw new Error('API_UNREACHABLE');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: string }).error;
    if (res.status >= 500 && !err) throw new Error('API_UNREACHABLE');
    throw new Error(err ?? `HTTP ${res.status}`);
  }
  return data;
}

function apiOfflineHelp(out: ShellLine[]): void {
  out.push({ text: 'BACKEND OFFLINE — API not running on :3001', cls: 'err' });
  out.push({ text: 'START: ./scripts/start-backend.sh', cls: 'info' });
  out.push({ text: '  or: npm run dev -w @noetis/api  (needs Postgres + Redis)', cls: 'out' });
}

const HELP_USER = `
NOETIS SHELL — USER COMMANDS
────────────────────────────
  help                     Show this help
  clear                    Clear terminal
  mode user|node           Switch shell mode
  version                  Show network version

  wallet create            Create user wallet
  wallet balance           Show NOET balance
  wallet address           Show wallet address
  faucet                   Request test NOET (dev only)

  ask "<prompt>"           Submit AI task (shorthand)
  task submit --prompt "..." [--model M] [--tokens N] [--verify low|medium|high]
  task status [id]         Check task status
  task result [id]         Get task result
  task watch [id]          Poll until complete

  nodes                    List processing nodes
  network                  Network statistics
  chain                    Recent blocks
  peers                    P2P peers

  connect api <url>        Set API endpoint
`.trim();

const HELP_NODE = `
NOETIS SHELL — NODE OPERATOR COMMANDS
────────────────────────────────────
  help                     Show this help
  clear                    Clear terminal
  mode user|node           Switch shell mode
  version                  Show network version

  wallet create            Create node operator wallet
  wallet balance           Show earned NOET
  wallet address           Show node wallet address

  node status              Your node registration status
  node models              Installed Ollama models (from registry)
  node config              Show node configuration
  node config set <k> <v>  Set config (input-price, output-price, ollama, coordinator, p2p)
  node start               Print node start command
  node install             Shareable Linux install one-liner (for friends)

  nodes                    List all network nodes
  network                  Network statistics
  chain                    Recent blocks

  connect api <url>        Set API endpoint
`.trim();

export async function executeCommand(
  input: string,
  state: ShellState
): Promise<{ lines: ShellLine[]; state: ShellState }> {
  const trimmed = input.trim();
  if (!trimmed) return { lines: [], state };

  const out: ShellLine[] = [{ text: `noetis@${state.mode}:~$ ${trimmed}`, cls: 'cmd' }];
  const { cmd, args, flags } = parseArgs(trimmed);
  const sub = args[0]?.toLowerCase();
  let next = { ...state };

  try {
    // ── GLOBAL ──
    if (cmd === 'help' || cmd === '?') {
      out.push({ text: state.mode === 'user' ? HELP_USER : HELP_NODE, cls: 'out' });
    } else if (cmd === 'clear' || cmd === 'cls') {
      return { lines: [], state: next };
    } else if (cmd === 'version') {
      out.push({ text: 'NOETIS COMPUTE v0.1.0 — decentralized AI inference network', cls: 'info' });
      out.push({ text: 'consensus: multi-validator BFT | transport: P2P gossip', cls: 'out' });
    } else if (cmd === 'mode') {
      const m = args[0] as ShellMode;
      if (m !== 'user' && m !== 'node') {
        out.push({ text: 'USAGE: mode user|node', cls: 'err' });
      } else {
        next.mode = m;
        out.push({ text: `MODE SET: ${m.toUpperCase()}`, cls: 'ok' });
      }
    } else if (cmd === 'connect' && sub === 'api') {
      next.apiUrl = args[1] ?? state.apiUrl;
      localStorage.setItem('noetis_api_url', next.apiUrl);
      out.push({ text: `API ENDPOINT: ${next.apiUrl}`, cls: 'ok' });
    }

    // ── WALLET ──
    else if (cmd === 'wallet') {
      const wMode = state.mode;
      if (sub === 'create') {
        const data = await apiFetch('/api/wallets', next, { method: 'POST' });
        const wallet = data as Wallet;
        saveWallet(wallet, wMode);
        if (wMode === 'user') next.userWallet = wallet;
        else next.nodeWallet = wallet;
        out.push({ text: 'WALLET CREATED', cls: 'ok' });
        out.push({ text: `ADDRESS: ${wallet.address}`, cls: 'out' });
        out.push({ text: 'PRIVATE KEY STORED IN LOCAL STORAGE — KEEP SECURE', cls: 'warn' });
      } else if (sub === 'balance') {
        const w = wMode === 'user' ? next.userWallet : next.nodeWallet;
        if (!w) { out.push({ text: 'NO WALLET — run: wallet create', cls: 'err' }); }
        else {
          const data = await apiFetch(`/api/wallets/${w.address}`, next);
          out.push({ text: `BALANCE: ${data.balance?.toFixed(6) ?? 0} NOET`, cls: 'ok' });
          if (data.chain_verified) out.push({ text: 'CHAIN-VERIFIED ✓', cls: 'info' });
          if (wMode === 'user') next.userWallet = { ...w, balance: data.balance };
          else next.nodeWallet = { ...w, balance: data.balance };
        }
      } else if (sub === 'address') {
        const w = wMode === 'user' ? next.userWallet : next.nodeWallet;
        if (!w) out.push({ text: 'NO WALLET', cls: 'err' });
        else out.push({ text: w.address, cls: 'out' });
      } else {
        out.push({ text: 'USAGE: wallet create|balance|address', cls: 'err' });
      }
    }

    // ── FAUCET ──
    else if (cmd === 'faucet') {
      const w = next.userWallet;
      if (!w) { out.push({ text: 'NO WALLET — run: wallet create', cls: 'err' }); }
      else {
        const data = await apiFetch('/api/faucet', next, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: w.address }),
        });
        out.push({ text: `FAUCET +${data.amount} NOET (dev only)`, cls: 'ok' });
        out.push({ text: `NEW BALANCE: ${data.balance?.toFixed(6)} NOET`, cls: 'info' });
      }
    }

    // ── ASK / TASK ──
    else if (cmd === 'ask' || (cmd === 'task' && sub === 'submit')) {
      const w = next.userWallet;
      if (!w?.private_key) { out.push({ text: 'NO WALLET — run: wallet create', cls: 'err' }); }
      else {
        const promptText = cmd === 'ask'
          ? args.join(' ')
          : (flags.prompt ?? args.slice(1).join(' '));
        if (!promptText) { out.push({ text: 'USAGE: ask "your prompt here"', cls: 'err' }); }
        else {
          const model = flags.model ?? 'llama3.2:3b';
          const maxTokens = parseInt(flags.tokens ?? '256', 10);
          const verification = flags.verify ?? 'low';
          const processingMode = flags.mode ?? 'single';
          out.push({ text: `SUBMITTING TASK → model:${model}`, cls: 'info' });
          const nonce = crypto.randomUUID();
          const timestamp = Date.now();
          const challenge = { wallet_address: w.address, timestamp, nonce };
          const message = JSON.stringify(challenge, Object.keys(challenge).sort());
          const signature = await signMessageDev(message, w.private_key);
          const data = await apiFetch('/api/tasks', next, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              wallet_address: w.address,
              prompt: promptText,
              model,
              max_output_tokens: maxTokens,
              verification_level: verification,
              processing_mode: processingMode,
              signature,
              timestamp,
              nonce,
            }),
          });
          next.lastTaskId = data.task_id;
          localStorage.setItem('noetis_last_task', data.task_id);
          out.push({ text: `TASK ID: ${data.task_id}`, cls: 'ok' });
          out.push({ text: `ESCROW: ${data.estimated_price?.toFixed(6)} NOET`, cls: 'warn' });
          out.push({ text: `NODES: ${(data.nodes as string[])?.join(', ') ?? 'pending'}`, cls: 'out' });
          out.push({ text: 'TIP: task watch — poll until complete', cls: 'info' });
        }
      }
    } else if (cmd === 'task') {
      const taskSub = sub;
      const taskId = args[1] ?? flags.id ?? next.lastTaskId;
      if (taskSub === 'status' && taskId) {
        const data = await apiFetch(`/api/tasks/${taskId}`, next);
        out.push({ text: `STATUS: ${data.status}`, cls: 'ok' });
        for (const p of (data.progress ?? []) as Array<{ status: string; message: string }>) {
          out.push({ text: `  [${p.status}] ${p.message ?? ''}`, cls: 'out' });
        }
      } else if (taskSub === 'result' && taskId) {
        const data = await apiFetch(`/api/tasks/${taskId}/result`, next);
        out.push({ text: '── RESULT ──', cls: 'ok' });
        out.push({ text: data.result ?? data.message ?? JSON.stringify(data), cls: 'out' });
      } else if (taskSub === 'watch' && taskId) {
        out.push({ text: `WATCHING TASK ${taskId.slice(0, 8)}...`, cls: 'info' });
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const data = await apiFetch(`/api/tasks/${taskId}`, next);
          const last = data.progress?.[data.progress.length - 1];
          out.push({ text: `[${data.status}] ${last?.message ?? ''}`, cls: 'info' });
          if (data.status === 'finalized') {
            const rd = await apiFetch(`/api/tasks/${taskId}/result`, next);
            out.push({ text: '── RESULT ──', cls: 'ok' });
            out.push({ text: rd.result, cls: 'out' });
            break;
          }
          if (data.status === 'failed') { out.push({ text: 'TASK FAILED', cls: 'err' }); break; }
        }
      } else {
        out.push({ text: 'USAGE: task status|result|watch [id]', cls: 'err' });
      }
    }

    // ── NETWORK ──
    else if (cmd === 'nodes') {
      const data = await apiFetch('/api/nodes', next);
      if (!Array.isArray(data) || data.length === 0) {
        out.push({ text: 'NO NODES REGISTERED', cls: 'warn' });
      } else {
        for (const n of data as Array<Record<string, unknown>>) {
          const models = (n.models as Array<{ name: string }>)?.map((m) => m.name).join(', ') ?? '';
          out.push({
            text: `${n.node_id} | ${n.status} | rep:${n.reputation} | ${models}`,
            cls: n.status === 'available' ? 'ok' : 'out',
          });
        }
      }
    } else if (cmd === 'network') {
      const data = await apiFetch('/api/network/stats', next);
      out.push({ text: `NODES: ${data.online_nodes}/${data.total_nodes} online`, cls: 'ok' });
      out.push({ text: `TASKS: ${data.completed_tasks}/${data.total_tasks} completed`, cls: 'out' });
      out.push({ text: `BLOCK HEIGHT: ${data.block_height}`, cls: 'out' });
      out.push({ text: `NOET SUPPLY: ${Math.round(data.total_noet_supply ?? 0)}`, cls: 'out' });
    } else if (cmd === 'chain') {
      const data = await apiFetch('/api/chain', next);
      const blocks = (data.chain ?? data) as Array<Record<string, unknown>>;
      if (!Array.isArray(blocks) || blocks.length === 0) {
        out.push({ text: 'CHAIN EMPTY — start full nodes', cls: 'warn' });
      } else {
        for (const b of blocks.slice(-8).reverse()) {
          out.push({
            text: `#${b.block_number} ${(b.hash as string)?.slice(0, 20)}... txs:${((b.transactions as unknown[]) ?? []).length}`,
            cls: 'out',
          });
        }
      }
    } else if (cmd === 'peers') {
      const data = await apiFetch('/api/peers', next);
      if (!Array.isArray(data) || data.length === 0) out.push({ text: 'NO PEERS CONNECTED', cls: 'warn' });
      else for (const p of data) out.push({ text: `${p.id} ${p.connected ? 'ONLINE' : 'OFFLINE'}`, cls: 'ok' });
    }

    // ── NODE OPS ──
    else if (cmd === 'node') {
      if (sub === 'status') {
        const w = next.nodeWallet ?? next.userWallet;
        if (!w) { out.push({ text: 'NO WALLET', cls: 'err' }); }
        else {
          const nodes = await apiFetch('/api/nodes', next);
          const mine = (nodes as Array<Record<string, unknown>>).find((n) => n.wallet_address === w.address);
          if (!mine) {
            out.push({ text: 'NODE NOT REGISTERED ON NETWORK', cls: 'warn' });
            out.push({ text: 'RUN: node start — then execute command locally', cls: 'info' });
          } else {
            out.push({ text: `NODE ID: ${mine.node_id}`, cls: 'ok' });
            out.push({ text: `STATUS: ${mine.status} | REP: ${mine.reputation}`, cls: 'out' });
            out.push({ text: `CPU: ${mine.cpu} | RAM: ${mine.ram_gb}GB | OS: ${mine.operating_system}`, cls: 'out' });
          }
        }
      } else if (sub === 'models') {
        const w = next.nodeWallet;
        const nodes = await apiFetch('/api/nodes', next);
        const mine = w
          ? (nodes as Array<Record<string, unknown>>).find((n) => n.wallet_address === w.address)
          : null;
        const models = (mine?.models as Array<{ name: string }>) ?? [];
        if (models.length === 0) out.push({ text: 'NO MODELS — start noetis-node with Ollama', cls: 'warn' });
        else models.forEach((m) => out.push({ text: `  ◈ ${m.name}`, cls: 'ok' }));
      } else if (sub === 'config') {
        if (args[1] === 'set' && args[2] && args[3]) {
          const key = args[2].replace(/-/g, '');
          const val = args[3];
          const map: Record<string, keyof NodeSettings> = {
            inputprice: 'inputPrice', outputprice: 'outputPrice',
            maxparallel: 'maxParallelTasks', minpayment: 'minTaskPayment',
            ollama: 'ollamaUrl', coordinator: 'coordinatorUrl', p2p: 'p2pBootstrap',
          };
          const k = map[key];
          if (!k) { out.push({ text: `UNKNOWN KEY: ${args[2]}`, cls: 'err' }); }
          else {
            const settings = { ...next.nodeSettings, [k]: k.includes('Price') || k.includes('Payment') || k.includes('Tasks') ? parseFloat(val) : val };
            next.nodeSettings = settings;
            localStorage.setItem('noetis_node_settings', JSON.stringify(settings));
            out.push({ text: `SET ${args[2]} = ${val}`, cls: 'ok' });
          }
        } else {
          const s = next.nodeSettings;
          out.push({ text: `input-price:    ${s.inputPrice}`, cls: 'out' });
          out.push({ text: `output-price:   ${s.outputPrice}`, cls: 'out' });
          out.push({ text: `max-parallel:   ${s.maxParallelTasks}`, cls: 'out' });
          out.push({ text: `ollama:         ${s.ollamaUrl}`, cls: 'out' });
          out.push({ text: `coordinator:    ${s.coordinatorUrl}`, cls: 'out' });
          out.push({ text: `p2p:            ${s.p2pBootstrap}`, cls: 'out' });
        }
      } else if (sub === 'start') {
        const s = next.nodeSettings;
        out.push({ text: 'EXECUTE ON YOUR MACHINE:', cls: 'info' });
        out.push({
          text: `noetis-node start --coordinator ${s.coordinatorUrl} --ollama ${s.ollamaUrl} --p2p-bootstrap ${s.p2pBootstrap} --wallet ./wallet.json`,
          cls: 'ok',
        });
        out.push({ text: 'SHARE WITH FRIENDS (Linux):', cls: 'info' });
        out.push({ text: linuxInstallLine('compute', s), cls: 'ok' });
      } else if (sub === 'install') {
        const s = next.nodeSettings;
        const variant = args[1]?.toLowerCase();
        out.push({ text: 'SHAREABLE LINUX COMMANDS — copy & send to friends', cls: 'info' });
        out.push({ text: '', cls: '' });
        if (!variant || variant === 'compute' || variant === 'node') {
          out.push({ text: '# AI compute node (needs Ollama)', cls: 'out' });
          out.push({ text: linuxInstallLine('compute', s), cls: 'ok' });
          out.push({ text: linuxInstallLine('compute', s, { run: true }), cls: 'out' });
        }
        if (!variant || variant === 'full' || variant === 'full-node') {
          out.push({ text: '# Full validator node (blockchain)', cls: 'out' });
          out.push({ text: linuxInstallLine('full-node', s), cls: 'ok' });
          out.push({ text: linuxInstallLine('full-node', s, { run: true }), cls: 'out' });
        }
        if (variant === 'seed') {
          out.push({ text: '# Seed network (first validator)', cls: 'out' });
          out.push({ text: linuxInstallLine('full-node', s, { seed: true }), cls: 'ok' });
          out.push({ text: linuxInstallLine('full-node', s, { seed: true, run: true }), cls: 'out' });
        }
        if (variant && !['compute', 'node', 'full', 'full-node', 'seed'].includes(variant)) {
          out.push({ text: 'USAGE: node install [compute|full|seed]', cls: 'err' });
        } else {
          out.push({ text: '', cls: '' });
          out.push({ text: `HOST DETECTED: ${hostFromWs(s.p2pBootstrap)} (set via: node config set p2p ws://IP:4001)`, cls: 'info' });
        }
      } else {
        out.push({ text: 'USAGE: node status|models|config|start|install', cls: 'err' });
      }
    }

    else {
      out.push({ text: `UNKNOWN COMMAND: ${cmd} — type 'help'`, cls: 'err' });
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'API_UNREACHABLE' || msg.includes('fetch') || msg.startsWith('HTTP 5')) {
      apiOfflineHelp(out);
    } else {
      out.push({ text: `ERROR: ${msg}`, cls: 'err' });
    }
  }

  return { lines: out, state: next };
}

export const COMMAND_HINTS = [
  'help', 'clear', 'version', 'mode user', 'mode node',
  'wallet create', 'wallet balance', 'wallet address', 'faucet',
  'ask', 'task submit', 'task status', 'task result', 'task watch',
  'nodes', 'network', 'chain', 'peers',
  'node status', 'node models', 'node config', 'node start', 'node install',
  'connect api',
];
