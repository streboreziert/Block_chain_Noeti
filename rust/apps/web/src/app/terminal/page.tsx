'use client';

import Link from 'next/link';
import { NoetisShell } from '../../components/NoetisShell';

export default function TerminalPage() {
  return (
    <div className="terminal-page">
      <div className="terminal-page-header">
        <pre className="ascii-logo" style={{ fontSize: 10 }}>{`╔═══════════════════════════════════════╗
║     NOETIS INTERACTIVE SHELL v0.1     ║
╚═══════════════════════════════════════╝`}</pre>
        <p>
          <Link href="/">← boot menu</Link>
          {' · '}
          <Link href="/user">user panel</Link>
          {' · '}
          <Link href="/node">node panel</Link>
        </p>
      </div>

      <div className="shell-quick-bar">
        <button type="button" className="shell-quick-btn" onClick={() => document.dispatchEvent(new CustomEvent('noetis-cmd', { detail: 'help' }))}>
          help
        </button>
        <button type="button" className="shell-quick-btn" onClick={() => document.dispatchEvent(new CustomEvent('noetis-cmd', { detail: 'wallet create' }))}>
          wallet create
        </button>
        <button type="button" className="shell-quick-btn" onClick={() => document.dispatchEvent(new CustomEvent('noetis-cmd', { detail: 'faucet' }))}>
          faucet
        </button>
        <button type="button" className="shell-quick-btn" onClick={() => document.dispatchEvent(new CustomEvent('noetis-cmd', { detail: 'network' }))}>
          network
        </button>
        <button type="button" className="shell-quick-btn" onClick={() => document.dispatchEvent(new CustomEvent('noetis-cmd', { detail: 'nodes' }))}>
          nodes
        </button>
        <button type="button" className="shell-quick-btn" onClick={() => document.dispatchEvent(new CustomEvent('noetis-cmd', { detail: 'mode node' }))}>
          mode node
        </button>
        <button type="button" className="shell-quick-btn" onClick={() => document.dispatchEvent(new CustomEvent('noetis-cmd', { detail: 'node install' }))}>
          node install
        </button>
      </div>

      <NoetisShell fullScreen />
    </div>
  );
}
