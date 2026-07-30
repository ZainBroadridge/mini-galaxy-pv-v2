import { config as loadEnvironment } from 'dotenv';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnvironment();
loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL_DIRECT or DATABASE_URL is required.');

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(here, '../../../db/migrations');
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('pv-v2-schema-migrations'))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const filename of files) {
    const existing = await client.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [filename],
    );
    if (existing.rowCount) continue;

    const sql = await readFile(path.join(migrationsDirectory, filename), 'utf8');
    console.log(`Applying ${filename}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log('Database migrations are current.');
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('pv-v2-schema-migrations'))").catch(() => {});
  await client.end();
}
