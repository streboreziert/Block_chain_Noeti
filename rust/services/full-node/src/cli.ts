import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Command } from 'commander';
import {
  createWallet,
  walletFromPrivateKey,
  deriveNodeId,
  hash,
  type Wallet,
} from '@noetis/crypto';
import {
  createBlockchain,
  ChainStore,
  Mempool,
  MultiValidatorConsensus,
  attestBlock,
  applyBlock,
  validateBlockSignatures,
  validateChain,
  deriveStateFromChain,
  getBlockHeight,
  getLatestBlock,
  getProposer,
  proposeBlock,
  queueTransaction,
  StakeRegistry,
  type AttestedBlock,
  type BlockchainState,
  type Validator,
} from '@noetis/blockchain';
import { GossipNetwork, peerUrl } from '@noetis/p2p';
import type { P2PMessage, Transaction } from '@noetis/protocol';
import { FAUCET_AMOUNT } from '@noetis/currency';
import { createTx } from '@noetis/blockchain';

interface FullNodeConfig {
  dataDir: string;
  p2pPort: number;
  httpPort: number;
  bootstraps: string[];
  isValidator: boolean;
  walletPath: string;
}

const pendingBlocks = new Map<string, AttestedBlock>();

function loadWallet(path: string): Promise<Wallet> {
  if (!existsSync(path)) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return createWallet().then((w) => {
      writeFileSync(path, JSON.stringify({
        address: w.address, publicKey: w.publicKey, privateKey: w.privateKey,
        boxPublicKey: w.boxPublicKey, boxSecretKey: Buffer.from(w.boxSecretKey).toString('hex'),
      }, null, 2));
      console.log(`Created validator wallet: ${w.address}`);
      return w;
    });
  }
  const data = JSON.parse(readFileSync(path, 'utf8')) as { privateKey: string; boxSecretKey?: string };
  return walletFromPrivateKey(data.privateKey, data.boxSecretKey);
}

async function initChain(
  dataDir: string,
  wallet: Wallet,
  validatorId: string,
  bootstraps: string[]
): Promise<BlockchainState> {
  const store = new ChainStore(join(dataDir, 'chain.json'));
  const loaded = store.load();
  const me: Validator = { id: validatorId, publicKey: wallet.publicKey, wallet, stake: 100 };

  if (loaded && loaded.chain.length > 0) {
    return {
      chain: loaded.chain,
      validators: [me],
      pendingTransactions: [],
      pendingSettlements: [],
    };
  }

  // Joiner: wait for P2P chain sync instead of creating a forked genesis
  if (bootstraps.length > 0) {
    console.log('Joining network — waiting for chain sync from bootstrap peer...');
    return {
      chain: [],
      validators: [me],
      pendingTransactions: [],
      pendingSettlements: [],
    };
  }

  const state = await createBlockchain([me]);
  store.saveState(state);
  return state;
}

async function runFullNode(config: FullNodeConfig): Promise<void> {
  const wallet = await loadWallet(config.walletPath);
  const nodeId = deriveNodeId(wallet.publicKey);
  const validatorId = process.env.VALIDATOR_ID ?? `validator-${nodeId.slice(0, 6)}`;

  let state = await initChain(config.dataDir, wallet, validatorId, config.bootstraps);
  const store = new ChainStore(join(config.dataDir, 'chain.json'));
  const mempool = new Mempool();
  const stakeRegistry = new StakeRegistry();
  stakeRegistry.register({ validatorId, address: wallet.address, stake: 100, slashed: 0 });

  const me: Validator = { id: validatorId, publicKey: wallet.publicKey, wallet, stake: 100 };
  if (!state.validators.find((v) => v.id === validatorId)) {
    state.validators.push(me);
  }

  const consensus = new MultiValidatorConsensus(state.validators);
  const publicHost = process.env.NOETIS_PUBLIC_HOST ?? process.env.PUBLIC_HOST;
  const network = new GossipNetwork(nodeId, wallet, config.p2pPort, publicHost);

  async function finalizeBlock(block: AttestedBlock): Promise<void> {
    const latest = getLatestBlock(state);
    if (block.block_number !== latest.block_number + 1) return;
    if (block.hash === latest.hash) return;

    const ok = await validateBlockSignatures(block, latest, state.validators);
    if (!ok) return;

    applyBlock(state, block);
    store.saveState(state, mempool.list());
    await network.gossip('BLOCK_FINAL', { block });
    console.log(`Block #${block.block_number} finalized (${Object.keys(block.validator_signatures ?? {}).length} sigs)`);
  }

  network.on('TX_GOSSIP', async (msg: P2PMessage) => {
    const tx = msg.payload.tx as Transaction;
    if (mempool.add(tx)) {
      await network.gossip('TX_GOSSIP', { tx }, 2);
    }
  });

  network.on('BLOCK_PROPOSED', async (msg: P2PMessage) => {
    const block = msg.payload.block as AttestedBlock;
    pendingBlocks.set(block.hash, block);

    if (config.isValidator && state.validators.some((v) => v.id === validatorId)) {
      const attested = await attestBlock(block, me);
      pendingBlocks.set(attested.hash, attested);
      await network.gossip('BLOCK_ATTEST', { block: attested });

      const sigCount = Object.keys(attested.validator_signatures ?? {}).length;
      if (sigCount >= consensus.quorum()) {
        await finalizeBlock(attested);
        pendingBlocks.delete(attested.hash);
      }
    }
  });

  network.on('BLOCK_ATTEST', async (msg: P2PMessage) => {
    const block = msg.payload.block as AttestedBlock;
    pendingBlocks.set(block.hash, block);
    const sigCount = Object.keys(block.validator_signatures ?? {}).length;
    if (sigCount >= consensus.quorum()) {
      await finalizeBlock(block);
      pendingBlocks.delete(block.hash);
    }
  });

  network.on('BLOCK_FINAL', async (msg: P2PMessage) => {
    const block = msg.payload.block as AttestedBlock;
    await finalizeBlock(block);
  });

  network.on('CHAIN_REQUEST', async (msg: P2PMessage, peerId: string) => {
    await network.sendDirect(peerId, 'CHAIN_RESPONSE', { chain: state.chain });
  });

  network.on('CHAIN_RESPONSE', async (msg: P2PMessage) => {
    const remoteChain = msg.payload.chain as AttestedBlock[];
    if (!remoteChain?.length || remoteChain.length <= state.chain.length) return;

    const testState = { ...state, chain: remoteChain };
    if (!(await validateChain(testState))) return;

    state.chain = remoteChain;
    store.saveState(state, mempool.list());
    console.log(`Synced chain to height ${remoteChain.length - 1}`);
  });

  network.on('HELLO', async (_msg: P2PMessage, peerId: string) => {
    await network.sendDirect(peerId, 'CHAIN_RESPONSE', { chain: state.chain });
  });

  network.on('TASK_OFFER', async (msg: P2PMessage) => {
    // Processing nodes pick up task offers from P2P gossip
    console.log(`Task offer received: ${(msg.payload.task_id as string)?.slice(0, 8)}...`);
  });

  await network.start(config.bootstraps);
  console.log(`Full node ${nodeId} listening P2P 0.0.0.0:${config.p2pPort}`);

  // Request chain sync from peers (retry until synced when joining)
  const syncInterval = setInterval(async () => {
    if (state.chain.length > 0) {
      clearInterval(syncInterval);
      return;
    }
    await network.broadcast('CHAIN_REQUEST', {});
  }, 3000);
  await network.broadcast('CHAIN_REQUEST', {});

  // Validator block production loop
  if (config.isValidator) {
    setInterval(async () => {
      const nextHeight = getBlockHeight(state) + 1;
      const proposer = getProposer(state.validators, nextHeight);
      if (proposer.id !== validatorId) return;

      const txs = mempool.drain();
      if (txs.length === 0) return;

      state.pendingTransactions = txs;
      const block = await proposeBlock(state, me);
      state.pendingTransactions = [];
      await network.gossip('BLOCK_PROPOSED', { block });
      console.log(`Proposed block #${block.block_number} with ${txs.length} tx(s)`);
    }, Number(process.env.BLOCK_TIME_MS ?? 15_000));
  }

  // HTTP API for queries and tx submission (any full node serves the network)
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, node_id: nodeId, height: getBlockHeight(state) }));
  app.get('/chain', (_req, res) => res.json({ chain: state.chain, height: getBlockHeight(state) }));
  app.get('/chain/balance/:address', (req, res) => {
    const txs = state.chain.map((b) => b.transactions);
    const accountState = deriveStateFromChain(txs);
    res.json({ address: req.params.address, balance: accountState.balances.get(req.params.address) ?? 0 });
  });
  app.get('/peers', (_req, res) => res.json(network.listPeers()));
  app.get('/validators', (_req, res) => res.json(stakeRegistry.toJSON()));

  app.post('/tx', async (req, res) => {
    const tx = req.body as Transaction;
    if (mempool.add(tx)) {
      await network.gossip('TX_GOSSIP', { tx });
      res.status(201).json({ accepted: true, id: tx.id });
    } else {
      res.status(409).json({ error: 'Duplicate transaction' });
    }
  });

  app.post('/faucet', async (req, res) => {
    const { address } = req.body as { address?: string };
    if (!address) return res.status(400).json({ error: 'address required' });
    const tx = createTx('FAUCET_TRANSFER', 'faucet-dev-only', address, FAUCET_AMOUNT, {
      note: 'DEVELOPMENT ONLY',
    });
    mempool.add(tx);
    await network.gossip('TX_GOSSIP', { tx });
    res.json({ amount: FAUCET_AMOUNT, tx_id: tx.id, warning: 'Dev-only test NOET' });
  });

  app.post('/task-offer', async (req, res) => {
    const offer = req.body as Record<string, unknown>;
    await network.gossip('TASK_OFFER', offer);
    res.json({ gossiped: true, task_id: offer.task_id });
  });

  app.listen(config.httpPort, () => {
    console.log(`Full node HTTP API :${config.httpPort}`);
    console.log(`Validator mode: ${config.isValidator}`);
    console.log(`Bootstraps: ${config.bootstraps.join(', ') || 'none (seed node)'}`);
  });
}

const program = new Command();
program
  .name('noetis-full-node')
  .description('Noetis full blockchain node with P2P sync')
  .command('start')
  .option('--data <dir>', 'Data directory', process.env.NOETIS_DATA_DIR ?? './data/full-node')
  .option('--p2p-port <n>', 'P2P gossip port', process.env.P2P_PORT ?? '4001')
  .option('--http-port <n>', 'HTTP API port', process.env.HTTP_PORT ?? '4000')
  .option('--bootstrap <url>', 'Bootstrap peer ws:// URL', process.env.P2P_BOOTSTRAP ?? '')
  .option('--validator', 'Participate as block validator', process.env.IS_VALIDATOR === 'true')
  .option('--wallet <path>', 'Validator wallet', process.env.NOETIS_WALLET_PATH ?? './data/full-node/wallet.json')
  .action(async (opts) => {
    const bootstraps = opts.bootstrap ? [opts.bootstrap] : [];
    await runFullNode({
      dataDir: opts.data,
      p2pPort: parseInt(opts.p2pPort, 10),
      httpPort: parseInt(opts.httpPort, 10),
      bootstraps,
      isValidator: !!opts.validator,
      walletPath: opts.wallet,
    });
  });

program.parse();
