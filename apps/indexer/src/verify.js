import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { query } from './db.js';
import { updateJob } from './queue.js';
import { permanentError } from './utils.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDirectory = resolve(here, '../../../packages/contracts');

function constructorArguments(event) {
  return [
    event.creator_address,
    event.token_address,
    String(event.record_date_block),
    event.snapshot_root,
    String(Math.floor(new Date(event.voting_start_at).getTime() / 1000)),
    String(Math.floor(new Date(event.voting_end_at).getTime() / 1000)),
    String(event.vote_unit),
    event.metadata_hash,
    String(event.proposal_config),
  ];
}

function runVerification(address, args) {
  return new Promise((resolvePromise, reject) => {
    const encodedArguments = Buffer.from(JSON.stringify(args), 'utf8').toString('base64url');
    const child = spawn(
      process.execPath,
      ['scripts/verify-runtime.cjs', address, encodedArguments],
      {
        cwd: contractsDirectory,
        env: { ...process.env, HARDHAT_NETWORK: 'amoy' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const normalized = output.toLowerCase();
      if (code === 0 || normalized.includes('already verified')) {
        resolvePromise(output);
      } else {
        reject(new Error(output.trim() || `Hardhat verify exited with code ${code}.`));
      }
    });
  });
}

export async function verifyContract(job) {
  if (!config.verifyContracts || !config.polygonScanApiKey) {
    return { skipped: true, reason: 'VERIFY_CONTRACTS or POLYGONSCAN_API_KEY is not configured.' };
  }
  const result = await query('SELECT * FROM events WHERE id = $1', [job.event_id]);
  if (!result.rowCount) throw permanentError('Event no longer exists.');
  const event = result.rows[0];
  if (!event.contract_address) throw permanentError('Contract address is missing.');

  await updateJob(job.id, 20, 'Submitting source code to PolygonScan');
  const output = await runVerification(event.contract_address, constructorArguments(event));
  const url = `${config.explorerUrl}/address/${event.contract_address}#code`;
  await query(
    `UPDATE events SET
       source_verification_status = 'VERIFIED',
       source_verification_url = $2,
       source_verification_error = NULL
     WHERE id = $1`,
    [event.id, url],
  );
  return { verified: true, url, output: output.slice(-2000) };
}
