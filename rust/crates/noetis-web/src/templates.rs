pub const STYLES: &str = r#"
:root {
  --bg: #0a0a0a;
  --fg: #00ff41;
  --fg-dim: #00aa2a;
  --amber: #ffb000;
  --warn: #ffaa00;
  --err: #ff4444;
  --border: #1a3a1a;
  --panel: #0d120d;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.5;
  min-height: 100vh;
}
a { color: var(--fg); text-decoration: none; }
a:hover { text-decoration: underline; }
.ascii-logo { color: var(--fg); font-size: 11px; white-space: pre; margin-bottom: 16px; }
.terminal {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 4px;
  overflow: hidden;
}
.terminal-header {
  background: #111;
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--fg-dim);
}
.terminal-body { padding: 12px; min-height: 120px; }
.terminal-log-line { display: block; }
.ts { color: #555; }
.ok { color: var(--fg); }
.warn { color: var(--warn); }
.err { color: var(--err); }
.info { color: #66ccff; }
.out { color: #aaa; }
.cmd { color: var(--amber); }
.cursor-blink { animation: blink 1s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }
.landing { max-width: 900px; margin: 40px auto; padding: 20px; }
.role-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 24px; }
.role-card {
  border: 1px solid var(--border);
  padding: 20px;
  border-radius: 4px;
  transition: border-color 0.2s;
  display: block;
}
.role-card:hover { border-color: var(--fg); text-decoration: none; }
.role-card.node { border-color: #3a2a00; }
.role-card.node:hover { border-color: var(--amber); }
.role-title { font-size: 16px; margin-bottom: 8px; }
.role-desc { color: #888; font-size: 12px; margin-bottom: 12px; }
.role-cmd { color: var(--fg-dim); font-size: 11px; }
.btn {
  background: transparent;
  border: 1px solid var(--fg);
  color: var(--fg);
  padding: 8px 16px;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  border-radius: 2px;
}
.btn:hover { background: #0a200a; }
.btn-primary { background: #0a200a; }
.btn-amber { border-color: var(--amber); color: var(--amber); }
.btn-sm { padding: 4px 10px; font-size: 11px; }
.dashboard { max-width: 1100px; margin: 0 auto; padding: 20px; }
.dash-topbar { display: flex; justify-content: space-between; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
.dash-topbar-label { font-size: 18px; letter-spacing: 2px; }
.dash-topbar-sub { color: #666; font-size: 11px; margin-top: 4px; }
.dash-api-badge { padding: 4px 10px; border: 1px solid var(--border); font-size: 11px; }
.dash-api-badge.online { border-color: var(--fg); color: var(--fg); }
.dash-api-badge.offline { border-color: var(--err); color: var(--err); }
.stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
.stat-box { border: 1px solid var(--border); padding: 12px; background: var(--panel); }
.stat-label { font-size: 10px; color: #666; text-transform: uppercase; }
.stat-value { font-size: 22px; margin-top: 4px; }
.stat-value.amber { color: var(--amber); }
.dash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.panel { border: 1px solid var(--border); background: var(--panel); border-radius: 4px; }
.panel-header { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; display: flex; justify-content: space-between; }
.panel-body { padding: 14px; }
.panel.node { border-color: #3a2a00; }
.wallet-balance { font-size: 24px; }
.wallet-balance .unit { font-size: 14px; color: #666; }
.wallet-addr { font-size: 10px; color: #666; word-break: break-all; margin-top: 4px; }
.dash-kv { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #111; font-size: 12px; }
.dash-kv span:first-child { color: #666; }
.dash-muted { color: #555; font-size: 12px; }
.model-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.model-chip { border: 1px solid var(--border); padding: 2px 8px; font-size: 11px; border-radius: 2px; }
.form-group { margin-bottom: 10px; }
.form-label { display: block; font-size: 10px; color: #666; margin-bottom: 4px; }
.form-textarea, .form-select {
  width: 100%;
  background: #0a0a0a;
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 8px;
  font-family: inherit;
  font-size: 12px;
  border-radius: 2px;
}
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.shell-wrap { margin-top: 16px; }
.shell-input-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.shell-prompt { color: var(--amber); white-space: nowrap; }
.shell-input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--fg);
  font-family: inherit;
  font-size: 13px;
  outline: none;
}
.shell-log { max-height: 300px; overflow-y: auto; }
.shell-quick-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.shell-quick-btn {
  background: #111;
  border: 1px solid var(--border);
  color: var(--fg-dim);
  padding: 4px 10px;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}
.shell-quick-btn:hover { border-color: var(--fg); color: var(--fg); }
.dash-terminal-panel { margin-top: 16px; }
.terminal-page { max-width: 900px; margin: 20px auto; padding: 20px; }
"#;

pub const SHELL_JS: &str = r#"
const API = '/api';
function ts() { return new Date().toISOString().slice(11,19); }
function loadState() {
  return {
    mode: localStorage.getItem('noetis_mode') || 'user',
    userWallet: JSON.parse(localStorage.getItem('noetis_wallet') || 'null'),
    nodeWallet: JSON.parse(localStorage.getItem('noetis_node_wallet') || 'null'),
    lastTaskId: localStorage.getItem('noetis_last_task'),
    nodeSettings: JSON.parse(localStorage.getItem('noetis_node_settings') || '{"ollamaUrl":"http://localhost:11434","coordinatorUrl":"ws://localhost:3002/ws","p2pBootstrap":"ws://localhost:4001","inputPrice":0.00001,"outputPrice":0.00003,"maxParallelTasks":2}')
  };
}
function saveWallet(w, mode) {
  localStorage.setItem(mode === 'node' ? 'noetis_node_wallet' : 'noetis_wallet', JSON.stringify(w));
  window.dispatchEvent(new Event('noetis-state-change'));
}
async function apiFetch(path, init) {
  const res = await fetch(API + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}
async function signMessage(message, privateKeyHex) {
  const bytes = new Uint8Array(privateKeyHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey('raw', bytes.slice(0,32), {name:'Ed25519'}, false, ['sign']);
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
function parseArgs(input) {
  const tokens = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(input)) !== null) tokens.push(m[1]??m[2]??m[3]);
  const flags = {}; const args = [];
  for (let i=1;i<tokens.length;i++) {
    const t = tokens[i];
    if (t.startsWith('--')) { const eq=t.indexOf('='); if(eq>0) flags[t.slice(2,eq)]=t.slice(eq+1);
      else if(tokens[i+1]&&!tokens[i+1].startsWith('--')) flags[t.slice(2)]=tokens[++i]; else flags[t.slice(2)]='true'; }
    else args.push(t);
  }
  return { cmd: (tokens[0]||'').toLowerCase(), args, flags };
}
async function executeCommand(input, state) {
  const trimmed = input.trim();
  if (!trimmed) return { lines: [], state };
  const out = [{ text: `noetis@${state.mode}:~$ ${trimmed}`, cls: 'cmd' }];
  const { cmd, args, flags } = parseArgs(trimmed);
  const sub = args[0]?.toLowerCase();
  let next = { ...state };
  try {
    if (cmd === 'help' || cmd === '?') {
      out.push({ text: state.mode === 'user' ? 'USER: wallet create|balance|faucet | ask "prompt" | task submit|status|result|watch | nodes|network|chain|peers | mode node' : 'NODE: wallet create|balance | node status|config|start|install | nodes|network|chain | mode user', cls: 'out' });
    } else if (cmd === 'clear') { return { lines: [], state: next }; }
    else if (cmd === 'version') { out.push({ text: 'NOETIS COMPUTE v0.2.0 — Rust network stack', cls: 'info' }); }
    else if (cmd === 'mode') { next.mode = args[0]; localStorage.setItem('noetis_mode', next.mode); out.push({ text: 'MODE: ' + next.mode, cls: 'ok' }); }
    else if (cmd === 'wallet') {
      const wMode = state.mode;
      if (sub === 'create') {
        const data = await apiFetch('/wallets', { method: 'POST' });
        saveWallet(data, wMode);
        if (wMode === 'user') next.userWallet = data; else next.nodeWallet = data;
        out.push({ text: 'WALLET: ' + data.address, cls: 'ok' });
      } else if (sub === 'balance') {
        const w = wMode === 'user' ? next.userWallet : next.nodeWallet;
        if (!w) out.push({ text: 'NO WALLET', cls: 'err' });
        else { const d = await apiFetch('/wallets/' + w.address); out.push({ text: 'BALANCE: ' + (d.balance?.toFixed(6)||0) + ' NOET', cls: 'ok' }); }
      } else if (sub === 'address') {
        const w = wMode === 'user' ? next.userWallet : next.nodeWallet;
        out.push({ text: w?.address || 'NO WALLET', cls: 'out' });
      }
    } else if (cmd === 'faucet') {
      const w = next.userWallet;
      if (!w) out.push({ text: 'NO WALLET', cls: 'err' });
      else { const d = await apiFetch('/faucet', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({address:w.address}) });
        out.push({ text: 'FAUCET +' + d.amount + ' NOET', cls: 'ok' }); }
    } else if (cmd === 'ask' || (cmd === 'task' && sub === 'submit')) {
      const w = next.userWallet;
      if (!w?.private_key) out.push({ text: 'NO WALLET', cls: 'err' });
      else {
        const promptText = cmd === 'ask' ? args.join(' ') : (flags.prompt || args.slice(1).join(' '));
        const nonce = crypto.randomUUID();
        const timestamp = Date.now();
        const challenge = { wallet_address: w.address, timestamp, nonce };
        const message = JSON.stringify(challenge, Object.keys(challenge).sort());
        const signature = await signMessage(message, w.private_key);
        const d = await apiFetch('/tasks', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
          wallet_address: w.address, prompt: promptText, model: flags.model||'llama3.2:3b',
          max_output_tokens: parseInt(flags.tokens||'256'), verification_level: flags.verify||'low',
          processing_mode: flags.mode||'single', signature, timestamp, nonce }) });
        next.lastTaskId = d.task_id;
        localStorage.setItem('noetis_last_task', d.task_id);
        out.push({ text: 'TASK: ' + d.task_id, cls: 'ok' });
        out.push({ text: 'PRICE: ' + d.estimated_price + ' NOET', cls: 'warn' });
      }
    } else if (cmd === 'task') {
      const taskId = args[1] || flags.id || next.lastTaskId;
      if (sub === 'status' && taskId) {
        const d = await apiFetch('/tasks/' + taskId);
        out.push({ text: 'STATUS: ' + d.status, cls: 'ok' });
        (d.progress||[]).forEach(p => out.push({ text: '  [' + p.status + '] ' + (p.message||''), cls: 'out' }));
      } else if (sub === 'result' && taskId) {
        const d = await apiFetch('/tasks/' + taskId + '/result');
        out.push({ text: '── RESULT ──', cls: 'ok' });
        out.push({ text: d.result || d.message || JSON.stringify(d), cls: 'out' });
      } else if (sub === 'watch' && taskId) {
        for (let i=0;i<30;i++) {
          await new Promise(r => setTimeout(r, 2000));
          const d = await apiFetch('/tasks/' + taskId);
          out.push({ text: '[' + d.status + ']', cls: 'info' });
          if (d.status === 'finalized') { const rd = await apiFetch('/tasks/' + taskId + '/result'); out.push({ text: rd.result, cls: 'out' }); break; }
          if (d.status === 'failed') break;
        }
      }
    } else if (cmd === 'nodes') {
      const d = await apiFetch('/nodes');
      (d||[]).forEach(n => out.push({ text: n.node_id + ' | ' + n.status + ' | rep:' + n.reputation, cls: n.status==='available'?'ok':'out' }));
    } else if (cmd === 'network') {
      const d = await apiFetch('/network/stats');
      out.push({ text: 'NODES: ' + d.online_nodes + '/' + d.total_nodes, cls: 'ok' });
      out.push({ text: 'BLOCK: ' + d.block_height, cls: 'out' });
    } else if (cmd === 'chain') {
      const d = await apiFetch('/chain');
      (d.chain||d||[]).slice(-8).reverse().forEach(b => out.push({ text: '#' + b.block_number + ' txs:' + (b.transactions?.length||0), cls: 'out' }));
    } else if (cmd === 'peers') {
      const d = await apiFetch('/peers');
      (d||[]).forEach(p => out.push({ text: p.id + ' ' + (p.connected?'ONLINE':'OFFLINE'), cls: 'ok' }));
    } else if (cmd === 'node') {
      if (sub === 'start') {
        const s = next.nodeSettings;
        out.push({ text: 'noetis-node start --coordinator ' + s.coordinatorUrl + ' --ollama ' + s.ollamaUrl, cls: 'ok' });
      } else if (sub === 'config') {
        out.push({ text: JSON.stringify(next.nodeSettings, null, 2), cls: 'out' });
      } else if (sub === 'status') {
        const w = next.nodeWallet || next.userWallet;
        const nodes = await apiFetch('/nodes');
        const mine = (nodes||[]).find(n => n.wallet_address === w?.address);
        out.push({ text: mine ? 'NODE: ' + mine.node_id + ' ' + mine.status : 'NOT REGISTERED', cls: mine?'ok':'warn' });
      } else out.push({ text: 'USAGE: node status|config|start|install', cls: 'err' });
    } else {
      out.push({ text: 'UNKNOWN: ' + cmd + " — type 'help'", cls: 'err' });
    }
  } catch(e) {
    out.push({ text: 'ERROR: ' + e.message, cls: 'err' });
    if (e.message.includes('fetch') || e.message.includes('Failed')) {
      out.push({ text: 'API OFFLINE — start noetis-api', cls: 'warn' });
    }
  }
  return { lines: out, state: next };
}
function mountShell(containerId, opts={}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  let state = loadState();
  if (opts.mode) state.mode = opts.mode;
  const log = document.createElement('div');
  log.className = 'shell-log';
  const inputRow = document.createElement('div');
  inputRow.className = 'shell-input-row';
  const prompt = document.createElement('span');
  prompt.className = 'shell-prompt';
  const input = document.createElement('input');
  input.className = 'shell-input';
  inputRow.append(prompt, input);
  el.append(log, inputRow);
  function renderPrompt() { prompt.textContent = `noetis@${state.mode}:~$ `; }
  function appendLines(lines) {
    lines.forEach(l => {
      const span = document.createElement('div');
      span.className = 'terminal-log-line ' + (l.cls||'');
      span.textContent = l.text;
      log.appendChild(span);
    });
    log.scrollTop = log.scrollHeight;
  }
  renderPrompt();
  input.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const val = input.value; input.value = '';
    const { lines, state: s } = await executeCommand(val, state);
    state = s; renderPrompt();
    appendLines(lines);
  });
  document.addEventListener('noetis-cmd', e => { input.value = e.detail; input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter'})); });
}
async function refreshDashboard(prefix) {
  try {
    const stats = await apiFetch('/network/stats');
    document.querySelectorAll('[data-stat="online"]').forEach(el => el.textContent = stats.online_nodes);
    document.querySelectorAll('[data-stat="tasks"]').forEach(el => el.textContent = stats.completed_tasks);
    document.querySelectorAll('[data-stat="height"]').forEach(el => el.textContent = stats.block_height);
    document.querySelectorAll('[data-stat="supply"]').forEach(el => el.textContent = Math.round(stats.total_noet_supply||0));
    const badge = document.getElementById(prefix + '-api-badge');
    if (badge) { badge.textContent = 'API ONLINE'; badge.className = 'dash-api-badge online'; }
    const nodes = await apiFetch('/nodes');
    const models = [...new Set((nodes||[]).flatMap(n => (n.models||[]).map(m => m.name)))];
    const ml = document.getElementById(prefix + '-models');
    if (ml) ml.innerHTML = models.map(m => `<span class="model-chip">${m}</span>`).join('') || '<span class="dash-muted">No models</span>';
    const state = loadState();
    const wallet = prefix === 'user' ? state.userWallet : state.nodeWallet;
    if (wallet) {
      const w = await apiFetch('/wallets/' + wallet.address);
      const bal = document.getElementById(prefix + '-balance');
      if (bal) bal.textContent = (w.balance||0).toFixed(4);
      const addr = document.getElementById(prefix + '-addr');
      if (addr) addr.textContent = wallet.address;
    }
  } catch {
    const badge = document.getElementById(prefix + '-api-badge');
    if (badge) { badge.textContent = 'API OFFLINE'; badge.className = 'dash-api-badge offline'; }
  }
}
"#;

pub const BOOT_PAGE: &str = r##"<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NOETIS COMPUTE</title><style>STYLES_PLACEHOLDER</style></head><body>
<div class="landing"><pre class="ascii-logo">╔══════════════════════════════════════════════════════╗
║  NOETIS COMPUTE  //  DECENTRALIZED AI INFERENCE NET  ║
╚══════════════════════════════════════════════════════╝</pre>
<div class="terminal"><div class="terminal-header"><span>[ SYSTEM BOOT ]</span></div>
<div class="terminal-body" id="boot-log"></div></div>
<div id="boot-menu" style="display:none">
<div class="role-grid">
<a href="/user" class="role-card user"><div class="role-title">◈ User Mode</div>
<div class="role-desc">Submit AI prompts. Pay with NOET. Receive inference results.</div>
<div class="role-cmd">$ noetis-cli --mode user</div></a>
<a href="/node" class="role-card node"><div class="role-title">◈ Compute Node</div>
<div class="role-desc">Run Ollama locally. Process tasks. Earn NOET.</div>
<div class="role-cmd">$ noetis-node start --ollama localhost:11434</div></a>
</div>
<div style="margin-top:16px;text-align:center"><a href="/terminal" class="btn">[ ENTER INTERACTIVE SHELL ]</a></div>
</div></div>
<script>
const BOOT=['NOETIS COMPUTE NETWORK v0.2.0','INITIALIZING DECENTRALIZED AI MESH...','LOADING CONSENSUS MODULE.............. OK','LOADING P2P GOSSIPSUB................ OK','LOADING OLLAMA BRIDGE................. STANDBY','LOADING NOET LEDGER................... OK','','SELECT OPERATING MODE:'];
const log=document.getElementById('boot-log'); let i=0;
function ts(){return new Date().toISOString().slice(11,19);}
function tick(){ if(i>=BOOT.length){document.getElementById('boot-menu').style.display='block';return;}
const line=document.createElement('span'); line.className='terminal-log-line';
if(BOOT[i]){line.innerHTML='<span class="ts">['+ts()+']</span> <span class="ok">'+BOOT[i]+'</span>';}
log.appendChild(line); i++; setTimeout(tick,120);} tick();
</script></body></html>"##;

pub const USER_PAGE: &str = r##"<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>NOETIS User Dashboard</title>
<style>STYLES_PLACEHOLDER</style></head><body>
<div class="dashboard"><header class="dash-topbar"><div>
<div class="dash-topbar-label">NOETIS USER DASHBOARD</div>
<div class="dash-topbar-sub">wallet · tokens · network · <a href="/terminal">terminal</a> · <a href="/">boot</a></div>
</div><div id="user-api-badge" class="dash-api-badge offline">API OFFLINE</div></header>
<div class="stats-row">
<div class="stat-box"><div class="stat-label">Your NOET</div><div class="stat-value" id="user-balance">—</div></div>
<div class="stat-box"><div class="stat-label">Nodes Online</div><div class="stat-value" data-stat="online">—</div></div>
<div class="stat-box"><div class="stat-label">Tasks Done</div><div class="stat-value" data-stat="tasks">—</div></div>
<div class="stat-box"><div class="stat-label">Block Height</div><div class="stat-value" data-stat="height">—</div></div>
</div>
<div class="dash-grid"><div class="panel"><div class="panel-header">Wallet</div><div class="panel-body">
<div class="wallet-balance"><span id="user-balance2">0</span> <span class="unit">NOET</span></div>
<div class="wallet-addr" id="user-addr">Create wallet in terminal below</div>
</div></div>
<div class="panel"><div class="panel-header">Network Models</div><div class="panel-body"><div class="model-list" id="user-models"></div></div></div>
</div>
<div class="panel dash-terminal-panel"><div class="panel-header">Command Terminal</div><div class="panel-body"><div id="user-shell"></div></div></div>
</div>
<script>SHELL_JS_PLACEHOLDER
mountShell('user-shell',{mode:'user'}); refreshDashboard('user');
setInterval(()=>refreshDashboard('user'),15000);
</script></body></html>"##;

pub const NODE_PAGE: &str = r##"<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>NOETIS Node Dashboard</title>
<style>STYLES_PLACEHOLDER</style></head><body>
<div class="dashboard dashboard-node"><header class="dash-topbar dash-topbar-node"><div>
<div class="dash-topbar-label">NOETIS NODE OPERATOR</div>
<div class="dash-topbar-sub">capabilities · earnings · <a href="/terminal">terminal</a> · <a href="/">boot</a></div>
</div><div id="node-api-badge" class="dash-api-badge offline">API OFFLINE</div></header>
<div class="stats-row">
<div class="stat-box"><div class="stat-label">Earned NOET</div><div class="stat-value amber" id="node-balance">—</div></div>
<div class="stat-box"><div class="stat-label">Network Nodes</div><div class="stat-value amber" data-stat="online">—</div></div>
<div class="stat-box"><div class="stat-label">Tasks Done</div><div class="stat-value amber" data-stat="tasks">—</div></div>
<div class="stat-box"><div class="stat-label">Block Height</div><div class="stat-value amber" data-stat="height">—</div></div>
</div>
<div class="panel node dash-terminal-panel"><div class="panel-header">Command Terminal</div><div class="panel-body"><div id="node-shell"></div></div></div>
</div>
<script>SHELL_JS_PLACEHOLDER
mountShell('node-shell',{mode:'node'}); refreshDashboard('node');
setInterval(()=>refreshDashboard('node'),15000);
</script></body></html>"##;

pub const TERMINAL_PAGE: &str = r##"<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>NOETIS Shell</title>
<style>STYLES_PLACEHOLDER</style></head><body>
<div class="terminal-page"><pre class="ascii-logo">╔═══════════════════════════════════════╗
║     NOETIS INTERACTIVE SHELL v0.2     ║
╚═══════════════════════════════════════╝</pre>
<p><a href="/">← boot</a> · <a href="/user">user</a> · <a href="/node">node</a></p>
<div class="shell-quick-bar">
<button class="shell-quick-btn" onclick="document.dispatchEvent(new CustomEvent('noetis-cmd',{detail:'help'}))">help</button>
<button class="shell-quick-btn" onclick="document.dispatchEvent(new CustomEvent('noetis-cmd',{detail:'wallet create'}))">wallet create</button>
<button class="shell-quick-btn" onclick="document.dispatchEvent(new CustomEvent('noetis-cmd',{detail:'faucet'}))">faucet</button>
<button class="shell-quick-btn" onclick="document.dispatchEvent(new CustomEvent('noetis-cmd',{detail:'network'}))">network</button>
<button class="shell-quick-btn" onclick="document.dispatchEvent(new CustomEvent('noetis-cmd',{detail:'nodes'}))">nodes</button>
<button class="shell-quick-btn" onclick="document.dispatchEvent(new CustomEvent('noetis-cmd',{detail:'mode node'}))">mode node</button>
</div>
<div class="terminal"><div class="terminal-body" id="fullscreen-shell"></div></div>
</div>
<script>SHELL_JS_PLACEHOLDER
mountShell('fullscreen-shell');
</script></body></html>"##;

pub fn render(page: &str) -> String {
    page.replace("STYLES_PLACEHOLDER", STYLES)
        .replace("SHELL_JS_PLACEHOLDER", SHELL_JS)
}

pub fn boot_html() -> String {
    render(BOOT_PAGE)
}
pub fn user_html() -> String {
    render(USER_PAGE)
}
pub fn node_html() -> String {
    render(NODE_PAGE)
}
pub fn terminal_html() -> String {
    render(TERMINAL_PAGE)
}
