import { config as loadEnvironment } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Workspace scripts run with their workspace as cwd. Load an optional local
// workspace .env first, then fall back to the repository-root .env. Render's
// real environment variables are never overridden.
loadEnvironment();
loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

function integer(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function list(names, fallback = []) {
  const source = names.map((name) => process.env[name]).find((value) => value);
  const values = String(source ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return [...new Set([...values, ...fallback])];
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: integer('PORT', 3001),
  chainId: integer('CHAIN_ID', 80002),
  databaseUrl: process.env.DATABASE_URL,
  rpcUrl: process.env.RPC_HTTP_URL ?? process.env.PUBLIC_RPC_URL,
  explorerUrl: (process.env.BLOCK_EXPLORER_URL ?? 'https://amoy.polygonscan.com').replace(/\/$/, ''),
  webOrigins: list(['WEB_ORIGINS', 'CORS_ORIGINS'], ['http://localhost:5173']),
  sessionTtlHours: integer('SESSION_TTL_HOURS', 24),
  nonceTtlMinutes: integer('AUTH_NONCE_TTL_MINUTES', integer('NONCE_TTL_MINUTES', 10)),
  rateLimitWindowMs: integer('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: integer('RATE_LIMIT_MAX', 240),
  eventsPerWalletPerDay: integer(
    'MAX_DEPLOYMENTS_PER_WALLET_PER_DAY',
    integer('EVENTS_PER_WALLET_PER_DAY', 5),
  ),
});

export function assertConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.rpcUrl) missing.push('RPC_HTTP_URL');
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  if (config.chainId !== 80002) {
    throw new Error('This V2 release is locked to Polygon Amoy (chain ID 80002).');
  }
}
