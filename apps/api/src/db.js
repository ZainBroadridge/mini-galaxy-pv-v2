import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
const remoteDatabase = config.databaseUrl && !config.databaseUrl.includes('localhost');

export const db = new Pool({
  connectionString: config.databaseUrl,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: remoteDatabase ? { rejectUnauthorized: false } : undefined,
});

db.on('error', (error) => console.error('Unexpected PostgreSQL pool error', error));

export function query(text, params = []) {
  return db.query(text, params);
}

export async function transaction(callback) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
