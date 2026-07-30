import { Transaction, getCreateAddress } from 'ethers';
import { config } from './config.js';
import { query, transaction } from './db.js';
import { provider, relayer } from './provider.js';
import { withAdvisoryLock } from './queue.js';
import { errorText } from './utils.js';

const ACTIVE_STATUSES = ['PREPARED', 'BROADCAST', 'CONFIRMED'];

function serializeReceipt(receipt) {
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    status: Number(receipt.status),
    contractAddress: receipt.contractAddress ?? null,
    gasUsed: receipt.gasUsed?.toString?.() ?? null,
    cumulativeGasUsed: receipt.cumulativeGasUsed?.toString?.() ?? null,
  };
}

async function activeTransaction(jobId, client = { query }) {
  const result = await client.query(
    `SELECT * FROM relayer_transactions
     WHERE job_id = $1 AND status = ANY($2::varchar[])
     ORDER BY created_at DESC
     LIMIT 1`,
    [jobId, ACTIVE_STATUSES],
  );
  return result.rows[0] ?? null;
}

async function nextRelayerNonce() {
  const [networkNonce, reserved] = await Promise.all([
    provider.getTransactionCount(relayer.address, 'pending'),
    query(
      `SELECT max(nonce) AS max_nonce
       FROM relayer_transactions
       WHERE chain_id = $1 AND relayer_address = $2`,
      [config.chainId, relayer.address.toLowerCase()],
    ),
  ]);
  const maximumReserved = reserved.rows[0]?.max_nonce === null
    ? -1
    : Number(reserved.rows[0].max_nonce);
  return Math.max(networkNonce, maximumReserved + 1);
}

/**
 * Creates and persists a signed raw relayer transaction before it is broadcast.
 * Persisting first lets a restarted worker safely rebroadcast the identical hash
 * instead of creating a second deployment or consuming another nonce.
 */
export async function prepareRelayerTransaction({
  job,
  eventId,
  voterAddress = null,
  transactionType,
  request,
  predictContractAddress = false,
  onPrepared = async () => {},
}) {
  const existing = await activeTransaction(job.id);
  if (existing) return existing;

  return withAdvisoryLock(`pv-v2-relayer-${config.chainId}`, async () => {
    const rechecked = await activeTransaction(job.id);
    if (rechecked) return rechecked;

    const nonce = await nextRelayerNonce();
    const populated = await relayer.populateTransaction({
      ...request,
      chainId: config.chainId,
      nonce,
    });
    const rawTransaction = await relayer.signTransaction(populated);
    const parsed = Transaction.from(rawTransaction);
    const transactionHash = parsed.hash;
    if (!transactionHash) throw new Error('Could not derive the signed relayer transaction hash.');
    const predictedContractAddress = predictContractAddress
      ? getCreateAddress({ from: relayer.address, nonce }).toLowerCase()
      : null;

    return transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO relayer_transactions (
           job_id, event_id, voter_address, chain_id, relayer_address,
           transaction_type, nonce, transaction_hash, raw_transaction,
           predicted_contract_address, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PREPARED')
         RETURNING *`,
        [
          job.id,
          eventId,
          voterAddress,
          config.chainId,
          relayer.address.toLowerCase(),
          transactionType,
          nonce,
          transactionHash,
          rawTransaction,
          predictedContractAddress,
        ],
      );
      const row = inserted.rows[0];
      await onPrepared(client, row);
      return row;
    });
  });
}

function isPossiblyAlreadyBroadcast(error) {
  const text = errorText(error).toLowerCase();
  return text.includes('already known')
    || text.includes('known transaction')
    || text.includes('nonce too low')
    || text.includes('already imported')
    || text.includes('replacement transaction underpriced');
}

async function recordReceipt(row, receipt) {
  const status = Number(receipt.status) === 1 ? 'CONFIRMED' : 'REVERTED';
  await query(
    `UPDATE relayer_transactions SET
       status = $2,
       receipt = $3::jsonb,
       confirmed_at = now(),
       last_error = CASE WHEN $2 = 'REVERTED' THEN 'Transaction reverted on-chain.' ELSE NULL END
     WHERE id = $1`,
    [row.id, status, JSON.stringify(serializeReceipt(receipt))],
  );
  return receipt;
}

/** Broadcasts (or rebroadcasts) the stored raw transaction and waits for one receipt. */
export async function broadcastPreparedTransaction(row, confirmations = 1) {
  const existingReceipt = await provider.getTransactionReceipt(row.transaction_hash);
  if (existingReceipt) {
    if (confirmations <= 1) return recordReceipt(row, existingReceipt);
    const confirmedReceipt = await provider.waitForTransaction(
      row.transaction_hash,
      confirmations,
      config.transactionWaitTimeoutMs,
    );
    if (!confirmedReceipt) {
      throw new Error(`Relayer transaction ${row.transaction_hash} is awaiting confirmations.`);
    }
    return recordReceipt(row, confirmedReceipt);
  }

  try {
    await provider.broadcastTransaction(row.raw_transaction);
    await query(
      `UPDATE relayer_transactions SET
         status = 'BROADCAST', broadcast_at = COALESCE(broadcast_at, now()), last_error = NULL
       WHERE id = $1 AND status <> 'CONFIRMED'`,
      [row.id],
    );
  } catch (error) {
    const receiptAfterError = await provider.getTransactionReceipt(row.transaction_hash).catch(() => null);
    if (receiptAfterError) return recordReceipt(row, receiptAfterError);

    const knownTransaction = await provider.getTransaction(row.transaction_hash).catch(() => null);
    if (knownTransaction || isPossiblyAlreadyBroadcast(error)) {
      await query(
        `UPDATE relayer_transactions SET
           status = 'BROADCAST', broadcast_at = COALESCE(broadcast_at, now()), last_error = $2
         WHERE id = $1 AND status <> 'CONFIRMED'`,
        [row.id, errorText(error).slice(0, 4000)],
      );
    } else {
      await query(
        `UPDATE relayer_transactions SET last_error = $2 WHERE id = $1`,
        [row.id, errorText(error).slice(0, 4000)],
      );
      throw error;
    }
  }

  const receipt = await provider.waitForTransaction(
    row.transaction_hash,
    confirmations,
    config.transactionWaitTimeoutMs,
  );
  if (!receipt) {
    throw new Error(`Relayer transaction ${row.transaction_hash} is still pending.`);
  }
  return recordReceipt(row, receipt);
}
