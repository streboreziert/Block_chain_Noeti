'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { DashboardPanel } from './DashboardPanel';
import { NoetisShell } from './NoetisShell';
import { useDashboard } from '../hooks/useDashboard';

function fmt(n: number | null | undefined, digits = 2) {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function shortAddr(addr: string) {
  return addr.length > 20 ? `${addr.slice(0, 10)}…${addr.slice(-8)}` : addr;
}

function fireCmd(cmd: string) {
  document.dispatchEvent(new CustomEvent('noetis-cmd', { detail: cmd }));
}

export function UserDashboard() {
  const { wallet, balance, stats, nodes, apiOnline, loading } = useDashboard('user');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('llama3.2:3b');
  const [lastTask, setLastTask] = useState<string | null>(null);

  useEffect(() => {
    setLastTask(localStorage.getItem('noetis_last_task'));
    const onChange = () => setLastTask(localStorage.getItem('noetis_last_task'));
    window.addEventListener('noetis-state-change', onChange);
    return () => window.removeEventListener('noetis-state-change', onChange);
  }, []);

  const onlineNodes = nodes.filter((n) => n.status === 'available');
  const allModels = [...new Set(onlineNodes.flatMap((n) => n.models?.map((m) => m.name) ?? []))];

  function submitTask() {
    if (!prompt.trim()) return;
    const escaped = prompt.replace(/"/g, '\\"');
    fireCmd(`task submit --prompt "${escaped}" --model ${model}`);
    setPrompt('');
  }

  return (
    <div className="dashboard">
      <header className="dash-topbar">
        <div>
          <div className="dash-topbar-label">NOETIS USER DASHBOARD</div>
          <div className="dash-topbar-sub">
            wallet · tokens · network · terminal
            {' · '}
            <Link href="/terminal">fullscreen shell</Link>
          </div>
        </div>
        <div className={`dash-api-badge ${apiOnline ? 'online' : 'offline'}`}>
          API {apiOnline ? 'ONLINE' : 'OFFLINE'}
        </div>
      </header>

      <div className="stats-row">
        <div className="stat-box">
          <div className="stat-label">Your NOET</div>
          <div className="stat-value">{loading ? '…' : fmt(balance, 4)}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Nodes Online</div>
          <div className="stat-value">{stats?.online_nodes ?? '—'}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Tasks Done</div>
          <div className="stat-value">{stats?.completed_tasks ?? '—'}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Block Height</div>
          <div className="stat-value">{stats?.block_height ?? '—'}</div>
        </div>
      </div>

      <div className="dash-grid dash-grid-user">
        <DashboardPanel
          title="Wallet & Tokens"
          actions={
            <div className="dash-actions">
              <button type="button" className="btn btn-sm" onClick={() => fireCmd('wallet create')}>create</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => fireCmd('faucet')}>faucet</button>
            </div>
          }
        >
          {wallet ? (
            <>
              <div className="wallet-block">
                <div className="wallet-balance">
                  {fmt(balance, 4)} <span className="unit">NOET</span>
                </div>
                <div className="wallet-addr" title={wallet.address}>{wallet.address}</div>
              </div>
              <div className="dash-kv">
                <span>Public key</span>
                <code>{shortAddr(wallet.public_key)}</code>
              </div>
              <div className="dash-kv">
                <span>Chain verified</span>
                <span className={wallet.chain_verified ? 'ok-text' : 'warn-text'}>
                  {wallet.chain_verified ? 'YES' : 'PENDING'}
                </span>
              </div>
            </>
          ) : (
            <div className="dash-empty">
              <p>No wallet yet.</p>
              <button type="button" className="btn btn-primary" onClick={() => fireCmd('wallet create')}>
                Create Wallet
              </button>
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel title="Network Capabilities">
          {allModels.length > 0 ? (
            <>
              <div className="dash-section-label">Available models</div>
              <div className="model-list">
                {allModels.map((m) => (
                  <span key={m} className="model-chip">{m}</span>
                ))}
              </div>
            </>
          ) : (
            <p className="dash-muted">No models online — start a compute node.</p>
          )}
          <div className="dash-section-label" style={{ marginTop: 16 }}>Processing nodes</div>
          <ul className="dash-node-list">
            {nodes.length === 0 && <li className="dash-muted">No nodes registered</li>}
            {nodes.slice(0, 6).map((n) => (
              <li key={n.node_id}>
                <span className={n.status === 'available' ? 'ok-text' : 'warn-text'}>{n.status}</span>
                {' '}
                {n.node_id.slice(0, 12)}…
                {' · '}
                rep {n.reputation}
              </li>
            ))}
          </ul>
        </DashboardPanel>

        <DashboardPanel title="Quick Task">
          <div className="form-group">
            <label className="form-label" htmlFor="prompt">Prompt</label>
            <textarea
              id="prompt"
              className="form-textarea"
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask the decentralized network..."
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="model">Model</label>
              <select id="model" className="form-select" value={model} onChange={(e) => setModel(e.target.value)}>
                {allModels.length > 0
                  ? allModels.map((m) => <option key={m} value={m}>{m}</option>)
                  : <option value="llama3.2:3b">llama3.2:3b</option>}
              </select>
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="button" className="btn btn-primary btn-block" onClick={submitTask} disabled={!prompt.trim() || !wallet}>
                Submit Task
              </button>
            </div>
          </div>
          {!wallet && <p className="dash-muted">Create a wallet first to submit tasks.</p>}
        </DashboardPanel>

        <DashboardPanel title="Your Activity">
          <div className="dash-kv">
            <span>Last task</span>
            <code>{lastTask?.slice(0, 16) ?? '—'}</code>
          </div>
          <div className="dash-kv">
            <span>Network supply</span>
            <span>{fmt(stats?.total_noet_supply, 0)} NOET</span>
          </div>
          <div className="dash-quick-cmds">
            <button type="button" className="shell-quick-btn" onClick={() => fireCmd('task watch')}>watch task</button>
            <button type="button" className="shell-quick-btn" onClick={() => fireCmd('network')}>network</button>
            <button type="button" className="shell-quick-btn" onClick={() => fireCmd('chain')}>chain</button>
          </div>
        </DashboardPanel>
      </div>

      <DashboardPanel title="Command Terminal" className="dash-terminal-panel">
        <NoetisShell initialMode="user" compact />
      </DashboardPanel>
    </div>
  );
}
