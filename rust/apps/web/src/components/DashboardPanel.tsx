interface DashboardPanelProps {
  title: string;
  accent?: 'user' | 'node';
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function DashboardPanel({ title, accent = 'user', actions, children, className = '' }: DashboardPanelProps) {
  return (
    <section className={`dash-panel dash-panel-${accent} ${className}`}>
      <header className="dash-panel-header">
        <span className="dash-panel-title">{title}</span>
        {actions}
      </header>
      <div className="dash-panel-body">{children}</div>
    </section>
  );
}
