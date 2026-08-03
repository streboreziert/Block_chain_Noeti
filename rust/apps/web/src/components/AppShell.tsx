import Link from 'next/link';

interface ShellProps {
  role: 'user' | 'node';
  children: React.ReactNode;
  onlineCount?: number;
}

export function AppShell({ role, children, onlineCount = 0 }: ShellProps) {
  const isUser = role === 'user';

  return (
    <div className="app-shell">
      <aside className={`sidebar ${isUser ? 'sidebar-user' : 'sidebar-node'}`}>
        <div className="brand">
          <div className="brand-tag">{isUser ? 'USER SHELL' : 'NODE OPERATOR'}</div>
          <pre className={`ascii-logo ${isUser ? '' : 'ascii-logo-node'}`} style={{ fontSize: 9, margin: 0 }}>
{isUser ? `┌─ NOETIS ─┐
│  USER   │
└─────────┘` : `┌─ NOETIS ─┐
│  NODE   │
└─────────┘`}
          </pre>
        </div>

        <nav className="nav">
          <Link href={isUser ? '/user' : '/node'} className="nav-item active">
            <span className="nav-prefix">{'>'}</span>
            dashboard
          </Link>
          <Link href="/terminal" className="nav-item">
            <span className="nav-prefix">{'>'}</span>
            terminal
          </Link>
        </nav>

        <div className="sidebar-footer">
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
            NODES ONLINE: <span style={{ color: 'var(--green)' }}>{onlineCount}</span>
          </div>
          <Link href="/" className="btn btn-block" style={{ fontSize: 10 }}>
            [ ESC ] SWITCH MODE
          </Link>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
