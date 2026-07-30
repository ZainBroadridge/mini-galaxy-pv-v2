import { config as loadEnvironment } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Workspace scripts run with their workspace as cwd. Load an optional local
// workspace .env first, then fall back to the repository-root .env. Render's
// real environment variables are never overridden.
loadEnvironment();
loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { randomUUID } from 'node:crypto';

function integer(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  chainId: integer('CHAIN_ID', 80002),
  databaseUrl: process.env.DATABASE_URL,
  rpcUrl: process.env.RPC_HTTP_URL ?? process.env.PUBLIC_RPC_URL,
  archiveRpcUrl: process.env.RPC_ARCHIVE_URL ?? process.env.RPC_HTTP_URL ?? process.env.PUBLIC_RPC_URL,
  relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY,
  explorerUrl: (process.env.BLOCK_EXPLORER_URL ?? 'https://amoy.polygonscan.com').replace(/\/$/, ''),
  polygonScanApiKey: process.env.POLYGONSCAN_API_KEY ?? '',
  verifyContracts: bool('VERIFY_CONTRACTS', false),
  confirmations: integer('CONFIRMATION_BLOCKS', 8),
  reorgOverlap: integer('REORG_OVERLAP_BLOCKS', 16),
  transferChunkSize: integer('TRANSFER_LOG_CHUNK_SIZE', 2500),
  voteChunkSize: integer('VOTE_LOG_CHUNK_SIZE', 2500),
  balanceConcurrency: integer('BALANCE_CALL_CONCURRENCY', 16),
  maxSnapshotCandidates: integer('MAX_SNAPSHOT_CANDIDATES', 100_000),
  tokenScanStartBlock: integer('TOKEN_SCAN_START_BLOCK', 0),
  pollIntervalMs: integer('WORKER_POLL_INTERVAL_MS', 1500),
  jobConcurrency: integer('JOB_CONCURRENCY', 3),
  jobLockMinutes: integer('JOB_LOCK_MINUTES', 10),
  transactionWaitTimeoutMs: integer('TRANSACTION_WAIT_TIMEOUT_MS', 180_000),
  workerId: process.env.WORKER_ID ?? `worker-${randomUUID()}`,
});

export function assertConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.rpcUrl) missing.push('RPC_HTTP_URL');
  if (!config.archiveRpcUrl) missing.push('RPC_ARCHIVE_URL');
  if (!config.relayerPrivateKey) missing.push('RELAYER_PRIVATE_KEY');
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  if (config.chainId !== 80002) throw new Error('This V2 worker is locked to Polygon Amoy.');
  if (config.jobConcurrency < 1 || config.jobConcurrency > 12) {
    throw new Error('JOB_CONCURRENCY must be between 1 and 12.');
  }
  if (config.maxSnapshotCandidates < 1) {
    throw new Error('MAX_SNAPSHOT_CANDIDATES must be positive.');
  }
  if (config.balanceConcurrency < 1 || config.balanceConcurrency > 64) {
    throw new Error('BALANCE_CALL_CONCURRENCY must be between 1 and 64.');
  }
}

