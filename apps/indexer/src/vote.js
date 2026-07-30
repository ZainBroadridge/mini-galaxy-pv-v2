import { Contract, Interface } from 'ethers';
import { VOTE_EVENT_ABI } from '@pv/shared';
import { config } from './config.js';
import { provider, relayer } from './provider.js';
import { query } from './db.js';
import { updateJob } from './queue.js';
import {
  broadcastPreparedTransaction,
  prepareRelayerTransaction,
} from './relayer-transaction.js';
import { permanentError } from './utils.js';

const voteInterface = new Interface(VOTE_EVENT_ABI);

function decodeVote(receipt, contractAddress) {
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== String(contractAddress).toLowerCase()) continue;
    try {
      const parsed = voteInterface.parseLog(log);
      if (parsed?.name === 'VoteCast') return { parsed, log };
    } catch {
      // Ignore unrelated logs.
    }
  }
  return null;
}

async function finalizeVote(event, vote, receipt) {
  if (Number(receipt.status) !== 1) throw permanentError('Relayed vote transaction reverted.');
  const decoded = decodeVote(receipt, event.contract_address);
  if (!decoded) throw permanentError('VoteCast was not found in the successful transaction receipt.');
  const voter = String(decoded.parsed.args.voter).toLowerCase();
  if (voter !== vote.voter_address) throw permanentError('VoteCast voter does not match the queued ballot.');
  const block = await provider.getBlock(receipt.blockNumber);
  await query(
    `UPDATE votes SET
       status = 'CONFIRMED',
       transaction_hash = $3,
       block_number = $4,
       block_hash = $5,
       log_index = $6,
       submitted_at = COALESCE(submitted_at, now()),
       confirmed_at = now(),
       failure_message = NULL
     WHERE event_id = $1 AND voter_address = $2`,
    [
      event.id,
      vote.voter_address,
      receipt.hash,
      receipt.blockNumber,
      block?.hash ?? receipt.blockHash,
      decoded.log.index ?? null,
    ],
  );
  return {
    eventId: event.id,
    voterAddress: vote.voter_address,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    votingPower: String(decoded.parsed.args.votingPower),
    transactionExplorerUrl: `${config.explorerUrl}/tx/${receipt.hash}`,
    contractExplorerUrl: `${config.explorerUrl}/address/${event.contract_address}#code`,
  };
}

export async function relayVote(job) {
  const result = await query(
    `SELECT e.*, v.id AS vote_id, v.voter_address, v.snapshot_balance,
            v.voting_power, v.choices_hex, v.voter_signature,
            v.status AS vote_status, v.transaction_hash,
            se.merkle_proof
     FROM events e
     JOIN votes v ON v.event_id = e.id AND v.voter_address = $2
     JOIN snapshot_entries se ON se.event_id = e.id AND se.wallet_address = v.voter_address
     WHERE e.id = $1`,
    [job.event_id, job.voter_address],
  );
  if (!result.rowCount) throw permanentError('Queued vote, event, or snapshot proof no longer exists.');
  const row = result.rows[0];
  const event = row;
  const vote = {
    voter_address: row.voter_address,
    snapshot_balance: row.snapshot_balance,
    choices_hex: row.choices_hex,
    voter_signature: row.voter_signature,
    transaction_hash: row.transaction_hash,
  };
  if (!event.contract_address || event.deployment_block === null) {
    throw new Error('VoteEvent deployment is not complete yet.');
  }
  if (row.vote_status === 'CONFIRMED') {
    return { alreadyConfirmed: true, transactionHash: row.transaction_hash };
  }

  const contract = new Contract(event.contract_address, VOTE_EVENT_ABI, relayer);
  const proof = Array.isArray(row.merkle_proof) ? row.merkle_proof : [];
  const args = [
    vote.voter_address,
    BigInt(vote.snapshot_balance),
    proof,
    vote.choices_hex,
    vote.voter_signature,
  ];

  await updateJob(job.id, 12, 'Simulating the signed ballot');
  await contract.castVote.staticCall(...args);
  const data = voteInterface.encodeFunctionData('castVote', args);
  const prepared = await prepareRelayerTransaction({
    job,
    eventId: event.id,
    voterAddress: vote.voter_address,
    transactionType: 'RELAY_VOTE',
    request: { to: event.contract_address, data },
    onPrepared: async (client, transactionRow) => {
      await client.query(
        `UPDATE votes SET
           status = 'SUBMITTED', transaction_hash = $3,
           submitted_at = COALESCE(submitted_at, now()), failure_message = NULL
         WHERE event_id = $1 AND voter_address = $2`,
        [event.id, vote.voter_address, transactionRow.transaction_hash],
      );
    },
  });

  await updateJob(job.id, 52, 'Vote broadcast to Polygon Amoy', {
    transactionHash: prepared.transaction_hash,
  });
  const receipt = await broadcastPreparedTransaction(prepared);
  await updateJob(job.id, 88, 'Vote mined; recording the receipt');
  return finalizeVote(
    event,
    { ...vote, transaction_hash: prepared.transaction_hash },
    receipt,
  );
}
