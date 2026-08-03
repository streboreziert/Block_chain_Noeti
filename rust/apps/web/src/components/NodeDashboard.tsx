'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { DashboardPanel } from './DashboardPanel';
import { NoetisShell } from './NoetisShell';
import { useDashboard } from '../hooks/useDashboard';
import { loadShellState } from '../lib/shell';
import { DEFAULT_NODE_SETTINGS, type NodeSettings } from '../lib/types';

function fmt(n: number | null | undefined, digits = 2) {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fireCmd(cmd: string) {
  document.dispatchEvent(new CustomEvent('noetis-cmd', { detail: cmd }));
}

export function NodeDashboard() {
  const { wallet, balance, stats, myNode, apiOnline, loading } = useDashboard('node');
  const [settings, setSettings] = useState<NodeSettings>(DEFAULT_NODE_SETTINGS);

  useEffect(() => {
    setSettings(loadShellState().nodeSettings);
    const onChange = () => setSettings(loadShellState().nodeSettings);
    window.addEventListener('noetis-state-change', onChange);
    return () => window.removeEventListener('noetis-state-change', onChange);
  }, []);

  const models = myNode?.models?.map((m) => m.name) ?? [];
  const registered = !!myNode;

  return (
    <div className="dashboard dashboard-node">
      <header className="dash-topbar dash-topbar-node">
        <div>
          <div className="dash-topbar-label">NOETIS NODE OPERATOR</div>
          <div className="dash-topbar-sub">
            capabilities · earnings · config · terminal
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
          <div className="stat-label">Earned NOET</div>
          <div className="stat-value amber">{loading ? '…' : fmt(balance, 4)}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Node Status</div>
          <div className={`stat-value amber ${registered ? 'status-online' : 'status-offline'}`}>
            {registered ? myNode!.status.toUpperCase() : 'OFFLINE'}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Reputation</div>
          <div className="stat-value amber">{myNode?.reputation ?? '—'}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Network Nodes</div>
          <div className="stat-value amber">{stats?.online_nodes ?? '—'}</div>
        </div>
      </div>

      <div className="dash-grid dash-grid-node">
        <DashboardPanel title="Your Capabilities" accent="node">
          {registered ? (
            <>
              <div className="status-grid">
                <div className="status-cell">
                  <div className="status-cell-label">CPU</div>
                  <div className="status-cell-value">{myNode?.cpu ?? '—'}</div>
                </div>
                <div className="status-cell">
                  <div className="status-cell-label">RAM</div>
                  <div className="status-cell-value">{myNode?.ram_gb ? `${myNode.ram_gb} GB` : '—'}</div>
                </div>
                <div className="status-cell">
                  <div className="status-cell-label">OS</div>
                  <div className="status-cell-value">{myNode?.operating_system ?? '—'}</div>
                </div>
              </div>
              <div className="dash-section-label" style={{ marginTop: 12 }}>Ollama models</div>
              {models.length > 0 ? (
                <div className="model-list">
                  {models.map((m) => <span key={m} className="model-chip">{m}</span>)}
                </div>
              ) : (
                <p className="dash-muted">No models reported — check Ollama.</p>
              )}
            </>
          ) : (
            <div className="dash-empty">
              <p>Node not registered on network.</p>
              <button type="button" className="btn btn-amber" onClick={() => fireCmd('node start')}>
                Show Start Command
              </button>
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel title="Wallet & Earnings" accent="node">
          {wallet ? (
            <>
              <div className="wallet-block" style={{ borderColor: '#5a4000' }}>
                <div className="wallet-balance amber">
                  {fmt(balance, 4)} <span className="unit">NOET</span>
                </div>
                <div className="wallet-addr">{wallet.address}</div>
              </div>
              <div className="dash-actions">
                <button type="button" className="btn btn-sm btn-amber" onClick={() => fireCmd('wallet create')}>new wallet</button>
                <button type="button" className="btn btn-sm btn-amber" onClick={() => fireCmd('wallet balance')}>refresh</button>
              </div>
            </>
          ) : (
            <div className="dash-empty">
              <button type="button" className="btn btn-amber" onClick={() => fireCmd('wallet create')}>
                Create Node Wallet
              </button>
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel title="Node Config" accent="node">
          <div className="dash-kv"><span>Ollama</span><code>{settings.ollamaUrl}</code></div>
          <div className="dash-kv"><span>Coordinator</span><code>{settings.coordinatorUrl}</code></div>
          <div className="dash-kv"><span>P2P bootstrap</span><code>{settings.p2pBootstrap}</code></div>
          <div className="dash-kv"><span>Input price</span><span>{settings.inputPrice} NOET/tok</span></div>
          <div className="dash-kv"><span>Output price</span><span>{settings.outputPrice} NOET/tok</span></div>
          <div className="dash-kv"><span>Max parallel</span><span>{settings.maxParallelTasks}</span></div>
          <div className="dash-quick-cmds" style={{ marginTop: 12 }}>
            <button type="button" className="shell-quick-btn" onClick={() => fireCmd('node config')}>config</button>
            <button type="button" className="shell-quick-btn" onClick={() => fireCmd('node install')}>share linux cmd</button>
          </div>
        </DashboardPanel>

        <DashboardPanel title="Network" accent="node">
          <div className="dash-kv"><span>Block height</span><span>{stats?.block_height ?? '—'}</span></div>
          <div className="dash-kv"><span>Tasks completed</span><span>{stats?.completed_tasks ?? '—'}</span></div>
          <div className="dash-kv"><span>NOET supply</span><span>{fmt(stats?.total_noet_supply, 0)}</span></div>
          <div className="dash-quick-cmds">
            <button type="button" className="shell-quick-btn" onClick={() => fireCmd('nodes')}>nodes</button>
            <button type="button" className="shell-quick-btn" onClick={() => fireCmd('peers')}>peers</button>
            <button type="button" className="shell-quick-btn" onClick={() => fireCmd('chain')}>chain</button>
          </div>
        </DashboardPanel>
      </div>

      <DashboardPanel title="Command Terminal" accent="node" className="dash-terminal-panel">
        <NoetisShell initialMode="node" compact />
      </DashboardPanel>
    </div>
  );
}
