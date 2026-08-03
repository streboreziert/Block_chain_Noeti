CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  public_key TEXT NOT NULL,
  models JSONB NOT NULL DEFAULT '[]',
  cpu TEXT,
  gpu TEXT,
  ram_gb DOUBLE PRECISION,
  vram_gb DOUBLE PRECISION,
  operating_system TEXT,
  price_per_input_token DOUBLE PRECISION DEFAULT 0.00001,
  price_per_output_token DOUBLE PRECISION DEFAULT 0.00003,
  maximum_parallel_tasks INT DEFAULT 2,
  reputation DOUBLE PRECISION DEFAULT 0,
  status TEXT DEFAULT 'available',
  metadata JSONB DEFAULT '{}',
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  user_address TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  result_hash TEXT,
  result_text TEXT,
  max_output_tokens INT NOT NULL,
  verification_level TEXT NOT NULL DEFAULT 'low',
  processing_mode TEXT NOT NULL DEFAULT 'single',
  estimated_price DOUBLE PRECISION NOT NULL,
  actual_price DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'created',
  node_addresses TEXT[] DEFAULT '{}',
  verification_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_progress (
  id SERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blocks (
  block_number INT PRIMARY KEY,
  previous_hash TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  transactions JSONB NOT NULL DEFAULT '[]',
  task_settlements JSONB NOT NULL DEFAULT '[]',
  validator_signature TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS escrows (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  user_address TEXT NOT NULL,
  locked_amount DOUBLE PRECISION NOT NULL,
  spent_amount DOUBLE PRECISION DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'locked'
);

CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_address);
CREATE INDEX IF NOT EXISTS idx_nodes_heartbeat ON nodes(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_task_progress_task ON task_progress(task_id);
