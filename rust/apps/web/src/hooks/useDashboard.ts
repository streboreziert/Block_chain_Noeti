'use client';

import { useCallback, useEffect, useState } from 'react';
import { loadShellState } from '../lib/shell';
import { API, type Wallet } from '../lib/types';

export interface NetworkStats {
  total_nodes: number;
  online_nodes: number;
  total_tasks: number;
  completed_tasks: number;
  total_noet_supply: number;
  block_height: number;
}

export interface NetworkNode {
  node_id: string;
  wallet_address: string;
  status: string;
  reputation: number;
  cpu?: string;
  ram_gb?: number;
  operating_system?: string;
  models?: Array<{ name: string }>;
}

export interface DashboardData {
  wallet: Wallet | null;
  balance: number | null;
  stats: NetworkStats | null;
  nodes: NetworkNode[];
  myNode: NetworkNode | null;
  apiOnline: boolean;
  loading: boolean;
}

const EMPTY: DashboardData = {
  wallet: null,
  balance: null,
  stats: null,
  nodes: [],
  myNode: null,
  apiOnline: false,
  loading: true,
};

export function useDashboard(mode: 'user' | 'node') {
  const [data, setData] = useState<DashboardData>(EMPTY);

  const refresh = useCallback(async () => {
    const state = loadShellState();
    const wallet = mode === 'node' ? state.nodeWallet ?? state.userWallet : state.userWallet;
    const base = state.apiUrl || API;

    let apiOnline = false;
    let stats: NetworkStats | null = null;
    let nodes: NetworkNode[] = [];
    let balance: number | null = null;

    try {
      const statsRes = await fetch(`${base}/api/network/stats`);
      apiOnline = statsRes.ok;
      if (statsRes.ok) stats = await statsRes.json();
      const nodesRes = await fetch(`${base}/api/nodes`);
      if (nodesRes.ok) nodes = await nodesRes.json();
    } catch {
      /* partial data ok */
    }

    if (wallet?.address) {
      try {
        const wRes = await fetch(`${base}/api/wallets/${wallet.address}`);
        if (wRes.ok) {
          const w = await wRes.json();
          balance = w.balance ?? 0;
        }
      } catch {
        balance = wallet.balance ?? null;
      }
    }

    const myNode = wallet
      ? nodes.find((n) => n.wallet_address === wallet.address) ?? null
      : null;

    setData({ wallet, balance, stats, nodes, myNode, apiOnline, loading: false });
  }, [mode]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 8000);
    const onChange = () => refresh();
    window.addEventListener('noetis-state-change', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      clearInterval(interval);
      window.removeEventListener('noetis-state-change', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, [refresh]);

  return { ...data, refresh };
}

export function dispatchStateChange() {
  window.dispatchEvent(new Event('noetis-state-change'));
}
