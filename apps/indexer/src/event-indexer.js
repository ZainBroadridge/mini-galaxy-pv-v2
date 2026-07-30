import { Interface } from 'ethers';
import { VOTE_EVENT_ABI } from '@pv/shared';
import { config } from './config.js';
import { provider } from './provider.js';
import { query, transaction } from './db.js';

const voteInterface = new Interface(VOTE_EVENT_ABI);
const voteTopic = voteInterface.getEvent('VoteCast').topicHash;

function choicesFromHex(value) {
  return Array.from(Buffer.from(String(value).slice(2), 'hex'));
}

async function recoverEventReorg(event, fromBlock) {
  const affected = await query(
    `SELECT * FROM votes
     WHERE event_id = $1 AND status = 'CONFIRMED' AND block_number >= $2
     ORDER BY block_number, log_index`,
    [event.id, fromBlock],
  );
  if (!affected.rowCount) return;

  const canonicalBlocks = new Map();
  const orphaned = [];
  for (const vote of affected.rows) {
    const number = Number(vote.block_number);
    if (!canonicalBlocks.has(number)) {
      canonicalBlocks.set(number, await provider.getBlock(number));
    }
    const canonical = canonicalBlocks.get(number);
    if (!canonical || canonical.hash !== vote.block_hash) orphaned.push(vote);
  }
  if (!orphaned.length) return;

  await transaction(async (client) => {
    for (const vote of orphaned) {
      if (vote.voter_signature === 'INDEXED_ON_CHAIN') {
        await client.query('DELETE FROM votes WHERE id = $1', [vote.id]);
        continue;
      }

      const relayerTransaction = await client.query(
        `SELECT * FROM relayer_transactions
         WHERE transaction_hash = $1
         FOR UPDATE`,
        [vote.transaction_hash],
      );

      if (relayerTransaction.rowCount) {
        const relayed = relayerTransaction.rows[0];
        // Reuse the exact signed raw transaction and nonce after an orphaned
        // receipt. Creating a higher-nonce replacement could leave a nonce gap.
        await client.query(
          `UPDATE votes SET
             status = 'SUBMITTED', block_number = NULL, block_hash = NULL,
             log_index = NULL, confirmed_at = NULL,
             failure_message = 'Previous receipt was orphaned by a chain reorganization; the original transaction is being rebroadcast.'
           WHERE id = $1`,
          [vote.id],
        );
        await client.query(
          `UPDATE relayer_transactions SET
             status = 'PREPARED', receipt = NULL, confirmed_at = NULL,
             broadcast_at = NULL,
             last_error = 'Previous receipt was orphaned; rebroadcasting the persisted raw transaction.'
           WHERE id = $1`,
          [relayed.id],
        );
        await client.query(
          `UPDATE jobs SET
             status = 'PENDING', progress = 0, result = NULL, attempts = 0,
             available_at = now(), locked_at = NULL, locked_by = NULL,
             progress_message = 'Requeued after chain reorganization', last_error = NULL
           WHERE id = $1`,
          [relayed.job_id],
        );
      } else {
        await client.query(
          `UPDATE votes SET
             status = 'QUEUED', transaction_hash = NULL, block_number = NULL,
             block_hash = NULL, log_index = NULL, submitted_at = NULL,
             confirmed_at = NULL,
             failure_message = 'Previous receipt was orphaned by a chain reorganization; resubmission queued.'
           WHERE id = $1`,
          [vote.id],
        );
        await client.query(
          `INSERT INTO jobs(event_id, voter_address, job_type, dedupe_key, payload, progress_message)
           VALUES ($1,$2,'RELAY_VOTE',$3,$4::jsonb,'Requeued after chain reorganization')
           ON CONFLICT DO NOTHING`,
          [
            event.id,
            vote.voter_address,
            `vote:${event.id}:${vote.voter_address}`,
            JSON.stringify({ eventId: event.id, voter: vote.voter_address, reason: 'CHAIN_REORG' }),
          ],
        );
      }
    }
  });
}

async function indexOneEvent(event, safeBlock) {
  const state = await query(
    'SELECT * FROM event_index_state WHERE event_id = $1',
    [event.id],
  );
  let next = Number(event.deployment_block);
  if (state.rowCount) {
    const current = state.rows[0];
    const lastScanned = Number(current.last_scanned_block);
    const canonical = await provider.getBlock(lastScanned);
    const reorgDetected = Boolean(
      current.last_scanned_block_hash
      && (!canonical || canonical.hash !== current.last_scanned_block_hash),
    );
    next = Math.max(
      Number(event.deployment_block),
      lastScanned + 1 - config.reorgOverlap,
    );
    if (reorgDetected) await recoverEventReorg(event, next);
  }
  if (next > safeBlock) return;

  while (next <= safeBlock) {
    const end = Math.min(safeBlock, next + config.voteChunkSize - 1);
    const logs = await provider.getLogs({
      address: event.contract_address,
      topics: [voteTopic],
      fromBlock: next,
      toBlock: end,
    });
    const endBlock = await provider.getBlock(end);
    await transaction(async (client) => {
      for (const log of logs) {
        const decoded = voteInterface.parseLog(log);
        if (!decoded) continue;
        const voter = String(decoded.args.voter).toLowerCase();
        const votingPower = decoded.args.votingPower.toString();
        const choicesHex = String(decoded.args.choices);
        const snapshot = await client.query(
          `SELECT raw_balance FROM snapshot_entries
           WHERE event_id = $1 AND wallet_address = $2`,
          [event.id, voter],
        );
        await client.query(
          `INSERT INTO votes(
             event_id, voter_address, snapshot_balance, voting_power,
             choices, choices_hex, voter_signature, status,
             transaction_hash, block_number, block_hash, log_index,
             submitted_at, confirmed_at
           ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'INDEXED_ON_CHAIN','CONFIRMED',$7,$8,$9,$10,now(),now())
           ON CONFLICT(event_id, voter_address) DO UPDATE SET
             voting_power = EXCLUDED.voting_power,
             choices = EXCLUDED.choices,
             choices_hex = EXCLUDED.choices_hex,
             status = 'CONFIRMED',
             transaction_hash = EXCLUDED.transaction_hash,
             block_number = EXCLUDED.block_number,
             block_hash = EXCLUDED.block_hash,
             log_index = EXCLUDED.log_index,
             confirmed_at = now(),
             failure_message = NULL`,
          [
            event.id,
            voter,
            snapshot.rows[0]?.raw_balance ?? '1',
            votingPower,
            JSON.stringify(choicesFromHex(choicesHex)),
            choicesHex,
            log.transactionHash,
            log.blockNumber,
            log.blockHash,
            log.index ?? null,
          ],
        );
      }
      await client.query(
        `INSERT INTO event_index_state(event_id, last_scanned_block, last_scanned_block_hash)
         VALUES ($1,$2,$3)
         ON CONFLICT(event_id) DO UPDATE SET
           last_scanned_block = EXCLUDED.last_scanned_block,
           last_scanned_block_hash = EXCLUDED.last_scanned_block_hash,
           updated_at = now()`,
        [event.id, end, endBlock?.hash ?? null],
      );
    });
    next = end + 1;
  }
}

export async function indexVoteEvents() {
  const latest = await provider.getBlockNumber();
  const safeBlock = Math.max(0, latest - config.confirmations);
  const result = await query(
    `SELECT * FROM events
     WHERE contract_address IS NOT NULL
       AND deployment_block IS NOT NULL
       AND status <> 'FAILED'
     ORDER BY deployment_block`,
  );
  for (const event of result.rows) await indexOneEvent(event, safeBlock);
  await query(
    `UPDATE events SET status = CASE
       WHEN now() < voting_start_at THEN 'SCHEDULED'
       WHEN now() <= voting_end_at THEN 'OPEN'
       ELSE 'CLOSED'
     END
     WHERE contract_address IS NOT NULL AND status <> 'FAILED'`,
  );
}

export async function reconcileSubmittedVotes() {
  const result = await query(
    `SELECT * FROM votes
     WHERE status = 'SUBMITTED'
       AND submitted_at < now() - interval '30 seconds'
     ORDER BY submitted_at
     LIMIT 100`,
  );
  for (const vote of result.rows) {
    const receipt = await provider.getTransactionReceipt(vote.transaction_hash);
    if (!receipt) continue;
    if (Number(receipt.status) === 0) {
      await query(
        `UPDATE votes SET status = 'FAILED', failure_message = 'Relayed transaction reverted.'
         WHERE id = $1 AND status <> 'CONFIRMED'`,
        [vote.id],
      );
    }
  }
}
