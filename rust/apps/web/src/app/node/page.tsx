'use client';

import { NodeDashboard } from '../../components/NodeDashboard';
import { AppShell } from '../../components/AppShell';
import { useDashboard } from '../../hooks/useDashboard';

export default function NodePage() {
  const { stats } = useDashboard('node');

  return (
    <AppShell role="node" onlineCount={stats?.online_nodes ?? 0}>
      <NodeDashboard />
    </AppShell>
  );
}
