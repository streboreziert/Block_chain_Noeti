'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const BOOT_LINES = [
  { text: 'NOETIS COMPUTE NETWORK v0.1.0', cls: 'ok' },
  { text: 'INITIALIZING DECENTRALIZED AI MESH...', cls: 'info' },
  { text: 'LOADING CONSENSUS MODULE.............. OK', cls: 'ok' },
  { text: 'LOADING P2P GOSSIPSUB................ OK', cls: 'ok' },
  { text: 'LOADING OLLAMA BRIDGE................. STANDBY', cls: 'warn' },
  { text: 'LOADING NOET LEDGER................... OK', cls: 'ok' },
  { text: '', cls: '' },
  { text: 'SELECT OPERATING MODE:', cls: 'info' },
];

function ts() {
  return new Date().toISOString().slice(11, 19);
}

export default function LandingPage() {
  const [visibleCount, setVisibleCount] = useState(0);
  const ready = visibleCount >= BOOT_LINES.length;

  useEffect(() => {
    if (visibleCount >= BOOT_LINES.length) return;

    const timer = setTimeout(() => {
      setVisibleCount((n) => n + 1);
    }, 120);

    return () => clearTimeout(timer);
  }, [visibleCount]);

  return (
    <div className="landing">
      <div className="landing-boot">
        <pre className="ascii-logo">{`╔══════════════════════════════════════════════════════╗
║  NOETIS COMPUTE  //  DECENTRALIZED AI INFERENCE NET  ║
╚══════════════════════════════════════════════════════╝`}</pre>

        <div className="terminal">
          <div className="terminal-header">
            <span>[ SYSTEM BOOT ]</span>
            <div className="terminal-dots">
              <span className="terminal-dot active" />
              <span className="terminal-dot" />
              <span className="terminal-dot" />
            </div>
          </div>
          <div className="terminal-body">
            <div className="terminal-log">
              {BOOT_LINES.slice(0, visibleCount).map((line, idx) => (
                <span key={idx} className="terminal-log-line">
                  {line.text ? (
                    <>
                      <span className="ts">[{ts()}]</span>{' '}
                      <span className={line.cls}>{line.text}</span>
                    </>
                  ) : null}
                </span>
              ))}
              {!ready && <span className="terminal-log-line cursor-blink">&nbsp;</span>}
            </div>
          </div>
        </div>

        {ready && (
          <>
            <div className="role-grid">
              <Link href="/user" className="role-card user">
                <div className="role-title">◈ User Mode</div>
                <div className="role-desc">
                  Submit AI prompts. Pay with NOET. Receive inference results from the distributed network.
                </div>
                <div className="role-cmd">$ noetis-cli --mode user --connect</div>
              </Link>
              <Link href="/node" className="role-card node">
                <div className="role-title">◈ Compute Node</div>
                <div className="role-desc">
                  Run Ollama locally. Process tasks. Earn NOET rewards. Monitor hardware and uptime.
                </div>
                <div className="role-cmd">$ noetis-node start --ollama localhost:11434</div>
              </Link>
            </div>
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <Link href="/terminal" className="btn" style={{ display: 'inline-flex' }}>
                [ ENTER INTERACTIVE SHELL ]
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
