import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskStatus } from '@noetis/protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createPool(connectionString?: string): pg.Pool {
  return new pg.Pool({
    connectionString: connectionString ?? process.env.DATABASE_URL ?? 'postgresql://noetis:noetis@localhost:5432/noetis',
  });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

export interface TaskRecord {
  id: string;
  user_address: string;
  model: string;
  prompt_hash: string;
  result_hash: string | null;
  result_text: string | null;
  max_output_tokens: number;
  verification_level: string;
  processing_mode: string;
  estimated_price: number;
  actual_price: number | null;
  status: TaskStatus;
  node_addresses: string[];
  verification_result: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export class TaskRepository {
  constructor(private pool: pg.Pool) {}

  async createTask(data: Omit<TaskRecord, 'created_at' | 'updated_at' | 'result_hash' | 'result_text' | 'actual_price' | 'verification_result'>): Promise<TaskRecord> {
    const res = await this.pool.query(
      `INSERT INTO tasks (id, user_address, model, prompt_hash, max_output_tokens, verification_level, processing_mode, estimated_price, status, node_addresses)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [data.id, data.user_address, data.model, data.prompt_hash, data.max_output_tokens, data.verification_level, data.processing_mode, data.estimated_price, data.status, data.node_addresses]
    );
    return res.rows[0];
  }

  async updateStatus(id: string, status: TaskStatus, extra: Partial<TaskRecord> = {}): Promise<void> {
    const fields = ['status = $2', 'updated_at = NOW()'];
    const values: unknown[] = [id, status];
    let idx = 3;
    if (extra.result_hash !== undefined) { fields.push(`result_hash = $${idx++}`); values.push(extra.result_hash); }
    if (extra.result_text !== undefined) { fields.push(`result_text = $${idx++}`); values.push(extra.result_text); }
    if (extra.actual_price !== undefined) { fields.push(`actual_price = $${idx++}`); values.push(extra.actual_price); }
    if (extra.verification_result !== undefined) { fields.push(`verification_result = $${idx++}`); values.push(JSON.stringify(extra.verification_result)); }
    if (extra.node_addresses !== undefined) { fields.push(`node_addresses = $${idx++}`); values.push(extra.node_addresses); }
    await this.pool.query(`UPDATE tasks SET ${fields.join(', ')} WHERE id = $1`, values);
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const res = await this.pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    return res.rows[0] ?? null;
  }

  async listTasks(userAddress?: string, limit = 50): Promise<TaskRecord[]> {
    if (userAddress) {
      const res = await this.pool.query('SELECT * FROM tasks WHERE user_address = $1 ORDER BY created_at DESC LIMIT $2', [userAddress, limit]);
      return res.rows;
    }
    const res = await this.pool.query('SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1', [limit]);
    return res.rows;
  }

  async countTasks(): Promise<number> {
    const res = await this.pool.query('SELECT COUNT(*)::int AS c FROM tasks');
    return res.rows[0].c;
  }

  async countCompleted(): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*)::int AS c FROM tasks WHERE status = 'finalized'");
    return res.rows[0].c;
  }
}

export class WalletRepository {
  constructor(private pool: pg.Pool) {}

  async upsertWallet(address: string, publicKey: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO wallets (address, public_key, balance) VALUES ($1, $2, 0)
       ON CONFLICT (address) DO UPDATE SET public_key = EXCLUDED.public_key`,
      [address, publicKey]
    );
  }

  async getWallet(address: string): Promise<{ address: string; public_key: string; balance: number } | null> {
    const res = await this.pool.query('SELECT * FROM wallets WHERE address = $1', [address]);
    return res.rows[0] ?? null;
  }

  async setBalance(address: string, balance: number): Promise<void> {
    await this.pool.query('UPDATE wallets SET balance = $2, updated_at = NOW() WHERE address = $1', [address, balance]);
  }

  async incrementBalance(address: string, delta: number): Promise<number> {
    const res = await this.pool.query(
      'UPDATE wallets SET balance = balance + $2, updated_at = NOW() WHERE address = $1 RETURNING balance',
      [address, delta]
    );
    return res.rows[0]?.balance ?? 0;
  }

  async totalSupply(): Promise<number> {
    const res = await this.pool.query('SELECT COALESCE(SUM(balance), 0)::float AS total FROM wallets');
    return res.rows[0].total;
  }
}

export class NodeRepository {
  constructor(private pool: pg.Pool) {}

  async upsertNode(node: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO nodes (node_id, wallet_address, public_key, models, cpu, gpu, ram_gb, vram_gb, operating_system,
        price_per_input_token, price_per_output_token, maximum_parallel_tasks, reputation, status, metadata, last_heartbeat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (node_id) DO UPDATE SET
         models = EXCLUDED.models, status = EXCLUDED.status, reputation = EXCLUDED.reputation,
         last_heartbeat = NOW(), metadata = EXCLUDED.metadata`,
      [
        node.node_id, node.wallet_address, node.public_key, JSON.stringify(node.models),
        node.cpu, node.gpu ?? null, node.ram_gb, node.vram_gb ?? null, node.operating_system,
        node.price_per_input_token, node.price_per_output_token, node.maximum_parallel_tasks,
        node.reputation ?? 0, node.status ?? 'available', JSON.stringify(node),
      ]
    );
  }

  async listNodes(): Promise<Array<Record<string, unknown>>> {
    const res = await this.pool.query('SELECT * FROM nodes ORDER BY last_heartbeat DESC');
    return res.rows.map((r) => ({ ...r, models: r.models }));
  }

  async countOnline(timeoutMs: number): Promise<number> {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS c FROM nodes WHERE last_heartbeat > NOW() - ($1 || ' milliseconds')::interval`,
      [String(timeoutMs)]
    );
    return res.rows[0].c;
  }

  async updateReputation(nodeId: string, reputation: number): Promise<void> {
    await this.pool.query('UPDATE nodes SET reputation = $2 WHERE node_id = $1', [nodeId, reputation]);
  }
}

export class BlockRepository {
  constructor(private pool: pg.Pool) {}

  async saveBlock(block: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO blocks (block_number, previous_hash, timestamp, transactions, task_settlements, validator_signature, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (block_number) DO NOTHING`,
      [block.block_number, block.previous_hash, block.timestamp, JSON.stringify(block.transactions), JSON.stringify(block.task_settlements), block.validator_signature, block.hash]
    );
  }

  async getHeight(): Promise<number> {
    const res = await this.pool.query('SELECT COALESCE(MAX(block_number), 0)::int AS h FROM blocks');
    return res.rows[0].h;
  }

  async listBlocks(limit = 20): Promise<Array<Record<string, unknown>>> {
    const res = await this.pool.query('SELECT * FROM blocks ORDER BY block_number DESC LIMIT $1', [limit]);
    return res.rows;
  }
}

export class ProgressRepository {
  constructor(private pool: pg.Pool) {}

  async addEvent(taskId: string, status: TaskStatus, message?: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO task_progress (task_id, status, message) VALUES ($1, $2, $3)',
      [taskId, status, message ?? null]
    );
  }

  async listEvents(taskId: string): Promise<Array<{ status: string; message: string | null; created_at: Date }>> {
    const res = await this.pool.query('SELECT status, message, created_at FROM task_progress WHERE task_id = $1 ORDER BY created_at ASC', [taskId]);
    return res.rows;
  }
}
