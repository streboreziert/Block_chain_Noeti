'use client';

import { UserDashboard } from '../../components/UserDashboard';
import { AppShell } from '../../components/AppShell';
import { useDashboard } from '../../hooks/useDashboard';

export default function UserPage() {
  const { stats } = useDashboard('user');

  return (
    <AppShell role="user" onlineCount={stats?.online_nodes ?? 0}>
      <UserDashboard />
    </AppShell>
  );
}
