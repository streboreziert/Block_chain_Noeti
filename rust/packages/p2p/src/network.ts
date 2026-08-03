import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { signPayload } from '@noetis/crypto';
import { P2PMessageSchema, type P2PMessage, type P2PMessageType } from '@noetis/protocol';
import type { Wallet } from '@noetis/crypto';

export interface PeerInfo {
  id: string;
  url: string;
  connected: boolean;
}

export type MessageHandler = (msg: P2PMessage, peerId: string) => void | Promise<void>;

/**
 * Decentralized WebSocket gossip mesh.
 * Tracks both outbound dials and inbound connections for bidirectional messaging.
 */
export class GossipNetwork {
  private server: WebSocketServer | null = null;
  /** peerId (node id or ws url) -> socket */
  private peers = new Map<string, WebSocket>();
  /** socket -> peerId */
  private wsPeer = new Map<WebSocket, string>();
  private handlers = new Map<P2PMessageType, MessageHandler[]>();
  private seen = new Set<string>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private nodeId: string,
    private wallet: Wallet,
    private listenPort: number,
    private publicHost?: string
  ) {}

  async start(bootstrapUrls: string[] = []): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server = new WebSocketServer({ port: this.listenPort, host: '0.0.0.0' }, resolve);
    });

    this.server!.on('connection', (ws) => {
      const tempId = `inbound:${randomUUID().slice(0, 8)}`;
      this.registerPeer(tempId, ws);
      ws.on('message', (data) => {
        const peerId = this.wsPeer.get(ws) ?? tempId;
        void this.handleIncoming(data.toString(), peerId);
      });
      ws.on('close', () => this.unregisterWs(ws));
      ws.on('error', () => this.unregisterWs(ws));
    });

    for (const url of bootstrapUrls) {
      await this.connect(url);
    }

    setInterval(() => this.broadcast('PEER_LIST', { peers: this.listPeers() }), 30_000);
  }

  on(type: P2PMessageType, handler: MessageHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  listPeers(): PeerInfo[] {
    return [...this.peers.entries()].map(([id, ws]) => ({
      id,
      url: id,
      connected: ws.readyState === WebSocket.OPEN,
    }));
  }

  private registerPeer(peerId: string, ws: WebSocket): void {
    this.peers.set(peerId, ws);
    this.wsPeer.set(ws, peerId);
  }

  private rekeyPeer(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const ws = this.peers.get(oldId);
    if (!ws) return;
    this.peers.delete(oldId);
    this.peers.set(newId, ws);
    this.wsPeer.set(ws, newId);
  }

  private unregisterWs(ws: WebSocket): void {
    const id = this.wsPeer.get(ws);
    if (id) {
      this.peers.delete(id);
      this.wsPeer.delete(ws);
    }
  }

  async connect(url: string): Promise<void> {
    if (this.peers.has(url)) return;

    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.on('open', () => {
        this.registerPeer(url, ws);
        ws.on('message', (data) => {
          const peerId = this.wsPeer.get(ws) ?? url;
          void this.handleIncoming(data.toString(), peerId);
        });
        ws.on('close', () => {
          this.unregisterWs(ws);
          if (!this.reconnectTimers.has(url)) {
            const t = setInterval(() => this.connect(url).catch(() => {}), 5000);
            this.reconnectTimers.set(url, t);
          }
        });
        void this.sendDirect(url, 'HELLO', {
          node_id: this.nodeId,
          listen_port: this.listenPort,
          public_host: this.publicHost,
        });
        resolve();
      });
      ws.on('error', () => resolve());
    });
  }

  async broadcast(type: P2PMessageType, payload: Record<string, unknown>): Promise<void> {
    const msg = await this.createMessage(type, payload);
    const raw = JSON.stringify(msg);
    for (const ws of this.peers.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
  }

  async sendDirect(peerId: string, type: P2PMessageType, payload: Record<string, unknown>): Promise<void> {
    const ws = this.peers.get(peerId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = await this.createMessage(type, payload);
    ws.send(JSON.stringify(msg));
  }

  async gossip(type: P2PMessageType, payload: Record<string, unknown>, ttl = 3): Promise<void> {
    await this.broadcast(type, { ...payload, _ttl: ttl });
  }

  private async createMessage(type: P2PMessageType, payload: Record<string, unknown>): Promise<P2PMessage> {
    const signature = await signPayload(payload, this.wallet);
    return {
      type,
      message_id: randomUUID(),
      timestamp: Date.now(),
      sender_id: this.nodeId,
      payload,
      signature,
    };
  }

  private async handleIncoming(raw: string, peerId: string): Promise<void> {
    try {
      const msg = P2PMessageSchema.parse(JSON.parse(raw));
      if (this.seen.has(msg.message_id)) return;
      this.seen.add(msg.message_id);
      if (this.seen.size > 10_000) this.seen.clear();

      // Bind inbound sockets to remote node id from HELLO
      if (msg.type === 'HELLO') {
        const remoteId = msg.payload.node_id as string | undefined;
        if (remoteId) {
          this.rekeyPeer(peerId, remoteId);
          peerId = remoteId;
        }
        const listenPort = msg.payload.listen_port as number | undefined;
        const host = (msg.payload.public_host as string | undefined) ?? '127.0.0.1';
        if (listenPort && remoteId && !this.peers.has(peerUrl(host, listenPort))) {
          void this.connect(peerUrl(host, listenPort)).catch(() => {});
        }
      }

      const ttl = (msg.payload._ttl as number | undefined) ?? 0;
      if (ttl > 0) {
        const forwarded = { ...msg.payload, _ttl: ttl - 1 };
        await this.broadcast(msg.type, forwarded);
      }

      const handlers = this.handlers.get(msg.type) ?? [];
      for (const h of handlers) await h(msg, peerId);
    } catch {
      // ignore malformed
    }
  }

  stop(): void {
    this.server?.close();
    for (const ws of this.peers.values()) ws.close();
    for (const t of this.reconnectTimers.values()) clearInterval(t);
  }
}

export function peerUrl(host: string, port: number): string {
  return `ws://${host}:${port}`;
}
