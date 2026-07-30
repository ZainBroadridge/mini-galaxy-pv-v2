import { Interface, toQuantity } from 'ethers';
import { STANDARD_ERC20_ABI, ZERO_ADDRESS, buildSnapshotTree } from '@pv/shared';
import { config } from './config.js';
import { archiveProvider, provider } from './provider.js';
import { query, transaction } from './db.js';
import { updateJob, withAdvisoryLock } from './queue.js';
import { mapWithConcurrency, permanentError } from './utils.js';

const erc20 = new Interface(STANDARD_ERC20_ABI);
const transferTopic = erc20.getEvent('Transfer').topicHash;
const zero = ZERO_ADDRESS.toLowerCase();

async function getBlock(number) {
  const value = await provider.getBlock(number);
  if (!value) throw new Error(`RPC did not return block ${number}.`);
  return value;
}

async function resolveRecordBlock(recordDateAt) {
  const latest = await provider.getBlockNumber();
  const safeNumber = Math.max(0, latest - config.confirmations);
  const safe = await getBlock(safeNumber);
  const requestedTimestamp = Math.floor(new Date(recordDateAt).getTime() / 1000);
  const targetTimestamp = Math.min(requestedTimestamp, safe.timestamp);
  let low = 0;
  let high = safeNumber;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = await getBlock(middle);
    if (candidate.timestamp <= targetTimestamp) low = middle;
    else high = middle - 1;
  }
  return getBlock(low);
}

async function codeAt(address, blockNumber) {
  return archiveProvider.send('eth_getCode', [address, toQuantity(blockNumber)]);
}

async function findDeploymentBlock(token, targetBlock) {
  if (token.token_deployment_block !== null) return Number(token.token_deployment_block);
  if ((await codeAt(token.token_address, targetBlock)) === '0x') {
    throw permanentError('The token contract did not exist at the selected record-date block.');
  }
  let low = Math.max(0, config.tokenScanStartBlock);
  let high = targetBlock;
  if ((await codeAt(token.token_address, low)) !== '0x') {
    await query(
      'UPDATE tokens SET deployment_block = $3 WHERE chain_id = $1 AND token_address = $2',
      [token.chain_id, token.token_address, low],
    );
    return low;
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await codeAt(token.token_address, middle)) === '0x') low = middle + 1;
    else high = middle;
  }
  await query(
    'UPDATE tokens SET deployment_block = $3 WHERE chain_id = $1 AND token_address = $2',
    [token.chain_id, token.token_address, low],
  );
  return low;
}

function topicAddress(topic) {
  return `0x${String(topic).slice(-40)}`.toLowerCase();
}

async function storeCandidates(client, token, candidates) {
  if (!candidates.size) return;
  const wallets = [];
  const firstBlocks = [];
  const lastBlocks = [];
  for (const [wallet, range] of candidates) {
    wallets.push(wallet);
    firstBlocks.push(range.first);
    lastBlocks.push(range.last);
  }
  await client.query(
    `INSERT INTO token_holder_candidates(
       chain_id, token_address, wallet_address, first_seen_block, last_seen_block
     )
     SELECT $1, $2, wallet, first_block, last_block
     FROM unnest($3::text[], $4::bigint[], $5::bigint[])
       AS x(wallet, first_block, last_block)
     ON CONFLICT(chain_id, token_address, wallet_address) DO UPDATE SET
       first_seen_block = LEAST(token_holder_candidates.first_seen_block, EXCLUDED.first_seen_block),
       last_seen_block = GREATEST(token_holder_candidates.last_seen_block, EXCLUDED.last_seen_block)`,
    [token.chain_id, token.token_address, wallets, firstBlocks, lastBlocks],
  );
}

async function scanTransferCandidates(token, deploymentBlock, targetBlock, jobId) {
  const cursorResult = await query(
    'SELECT * FROM token_index_cursors WHERE chain_id = $1 AND token_address = $2',
    [token.chain_id, token.token_address],
  );
  let next = deploymentBlock;
  if (cursorResult.rowCount) {
    const cursor = cursorResult.rows[0];
    const cursorBlock = await archiveProvider.getBlock(Number(cursor.last_scanned_block));
    const cursorMatches = !cursor.last_scanned_block_hash
      || cursorBlock?.hash === cursor.last_scanned_block_hash;
    next = cursorMatches
      ? Number(cursor.last_scanned_block) + 1
      : Math.max(deploymentBlock, Number(cursor.last_scanned_block) - config.reorgOverlap);
  }
  if (next > targetBlock) return;

  const scanStart = next;
  let chunkSize = config.transferChunkSize;
  while (next <= targetBlock) {
    const end = Math.min(targetBlock, next + chunkSize - 1);
    let logs;
    try {
      logs = await archiveProvider.getLogs({
        address: token.token_address,
        topics: [transferTopic],
        fromBlock: next,
        toBlock: end,
      });
    } catch (error) {
      if (chunkSize > 25) {
        chunkSize = Math.max(25, Math.floor(chunkSize / 2));
        continue;
      }
      throw error;
    }

    const candidates = new Map();
    for (const log of logs) {
      for (const wallet of [topicAddress(log.topics[1]), topicAddress(log.topics[2])]) {
        if (wallet === zero) continue;
        const previous = candidates.get(wallet);
        candidates.set(wallet, {
          first: Math.min(previous?.first ?? log.blockNumber, log.blockNumber),
          last: Math.max(previous?.last ?? log.blockNumber, log.blockNumber),
        });
      }
    }
    const endBlock = await archiveProvider.getBlock(end);
    await transaction(async (client) => {
      await storeCandidates(client, token, candidates);
      await client.query(
        `INSERT INTO token_index_cursors(
           chain_id, token_address, last_scanned_block, last_scanned_block_hash
         ) VALUES ($1,$2,$3,$4)
         ON CONFLICT(chain_id, token_address) DO UPDATE SET
           last_scanned_block = EXCLUDED.last_scanned_block,
           last_scanned_block_hash = EXCLUDED.last_scanned_block_hash,
           updated_at = now()`,
        [token.chain_id, token.token_address, end, endBlock?.hash ?? null],
      );
    });
    const total = Math.max(1, targetBlock - scanStart + 1);
    const done = end - scanStart + 1;
    await updateJob(jobId, Math.min(55, 10 + Math.floor((done / total) * 45)), `Indexed ERC-20 Transfer logs through block ${end}`);
    next = end + 1;
    if (logs.length < 200 && chunkSize < config.transferChunkSize) {
      chunkSize = Math.min(config.transferChunkSize, chunkSize * 2);
    }
  }
}

async function historicalCall(to, data, blockNumber) {
  return archiveProvider.send('eth_call', [{ to, data }, toQuantity(blockNumber)]);
}

async function balanceAt(tokenAddress, walletAddress, blockNumber) {
  const data = erc20.encodeFunctionData('balanceOf', [walletAddress]);
  const value = await historicalCall(tokenAddress, data, blockNumber);
  return erc20.decodeFunctionResult('balanceOf', value)[0];
}

async function totalSupplyAt(tokenAddress, blockNumber) {
  const data = erc20.encodeFunctionData('totalSupply');
  const value = await historicalCall(tokenAddress, data, blockNumber);
  return erc20.decodeFunctionResult('totalSupply', value)[0];
}

async function insertEntries(client, eventId, entries) {
  const batchSize = 200;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    const params = [];
    const rows = batch.map((entry, index) => {
      const base = index * 7;
      params.push(
        eventId,
        entry.walletAddress,
        entry.rawBalance,
        entry.votingPower,
        entry.leafIndex,
        entry.leafHash,
        JSON.stringify(entry.merkleProof),
      );
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7}::jsonb)`;
    });
    await client.query(
      `INSERT INTO snapshot_entries(
         event_id, wallet_address, raw_balance, voting_power,
         leaf_index, leaf_hash, merkle_proof
       ) VALUES ${rows.join(',')}`,
      params,
    );
  }
}

export async function buildSnapshot(job) {
  const eventResult = await query(
    `SELECT e.*, t.deployment_block AS token_deployment_block, t.standard_status
     FROM events e
     JOIN tokens t ON t.chain_id = e.chain_id AND t.token_address = e.token_address
     WHERE e.id = $1`,
    [job.event_id],
  );
  if (!eventResult.rowCount) throw permanentError('Event no longer exists.');
  const event = eventResult.rows[0];
  if (event.contract_address) return { alreadyDeployed: true, contractAddress: event.contract_address };
  if (new Date(event.record_date_at).getTime() > Date.now()) {
    throw permanentError('Record date is in the future. V2 only supports present or past record dates.');
  }
  if (new Date(event.voting_end_at).getTime() <= Date.now()) {
    throw permanentError('Voting ended before the snapshot could be completed.');
  }

  await query(
    `UPDATE events SET status = 'SNAPSHOT_RUNNING', failure_reason = NULL WHERE id = $1`,
    [event.id],
  );
  await updateJob(job.id, 3, 'Resolving the finalized record-date block');
  const recordBlock = await resolveRecordBlock(event.record_date_at);
  const deploymentBlock = await findDeploymentBlock(event, recordBlock.number);

  await updateJob(job.id, 8, `Scanning standard ERC-20 transfers from block ${deploymentBlock}`);
  // Events for the same token may be created simultaneously. Serialize only
  // that token's cursor mutation; snapshots for different tokens remain fully
  // parallel, and balance/Merkle work resumes independently after this lock.
  await withAdvisoryLock(
    `token-scan:${event.chain_id}:${event.token_address}`,
    () => scanTransferCandidates(event, deploymentBlock, recordBlock.number, job.id),
  );

  const candidatesResult = await query(
    `SELECT wallet_address FROM token_holder_candidates
     WHERE chain_id = $1 AND token_address = $2
     ORDER BY wallet_address`,
    [event.chain_id, event.token_address],
  );
  if (!candidatesResult.rowCount) {
    throw permanentError('No token holders were discovered from standard ERC-20 Transfer events.');
  }
  if (candidatesResult.rowCount > config.maxSnapshotCandidates) {
    throw permanentError(
      `This token has ${candidatesResult.rowCount} holder candidates, above the configured MAX_SNAPSHOT_CANDIDATES limit of ${config.maxSnapshotCandidates}.`,
    );
  }

  await updateJob(job.id, 60, `Reading ${candidatesResult.rowCount} historical balances`);
  let completed = 0;
  const balances = await mapWithConcurrency(
    candidatesResult.rows,
    config.balanceConcurrency,
    async ({ wallet_address: walletAddress }) => {
      const rawBalance = await balanceAt(event.token_address, walletAddress, recordBlock.number);
      completed += 1;
      if (completed % 100 === 0 || completed === candidatesResult.rowCount) {
        await updateJob(
          job.id,
          Math.min(80, 60 + Math.floor((completed / candidatesResult.rowCount) * 20)),
          `Read ${completed}/${candidatesResult.rowCount} historical balances`,
        );
      }
      return { walletAddress, rawBalance };
    },
  );

  const positive = balances.filter((entry) => entry.rawBalance > 0n);
  const reconstructedSupply = positive.reduce((total, entry) => total + entry.rawBalance, 0n);
  const historicalSupply = await totalSupplyAt(event.token_address, recordBlock.number);
  if (reconstructedSupply !== historicalSupply) {
    await query(
      `UPDATE tokens SET standard_status = 'UNSUPPORTED', validation_message = $3
       WHERE chain_id = $1 AND token_address = $2`,
      [
        event.chain_id,
        event.token_address,
        `Transfer reconstruction produced ${reconstructedSupply}; historical totalSupply was ${historicalSupply}.`,
      ],
    );
    throw permanentError(
      'Token history is not compatible with the V2 standard ERC-20 snapshot rules: reconstructed balances do not equal historical totalSupply.',
    );
  }

  const voteUnit = BigInt(event.vote_unit);
  const eligible = positive
    .map((entry) => ({
      walletAddress: entry.walletAddress,
      rawBalance: entry.rawBalance.toString(),
      votingPower: (entry.rawBalance / voteUnit).toString(),
    }))
    .filter((entry) => BigInt(entry.votingPower) > 0n);
  if (!eligible.length) {
    throw permanentError('No holder has one complete vote under the selected token-to-vote ratio.');
  }

  await updateJob(job.id, 84, 'Building the Merkle eligibility tree');
  const tree = buildSnapshotTree(eligible);
  await transaction(async (client) => {
    await client.query('DELETE FROM snapshot_entries WHERE event_id = $1', [event.id]);
    await insertEntries(client, event.id, tree.entries);
    await client.query(
      `UPDATE events SET
         record_date_block = $2,
         record_date_block_hash = $3,
         snapshot_root = $4,
         snapshot_holder_count = $5,
         snapshot_total_balance = $6,
         status = 'DEPLOYMENT_QUEUED',
         failure_reason = NULL
       WHERE id = $1`,
      [
        event.id,
        recordBlock.number,
        recordBlock.hash,
        tree.root,
        tree.entries.length,
        reconstructedSupply.toString(),
      ],
    );
    await client.query(
      `INSERT INTO jobs(event_id, job_type, dedupe_key, payload, progress_message)
       VALUES ($1, 'DEPLOY_EVENT', $2, $3::jsonb, 'Sponsored one-contract deployment queued')
       ON CONFLICT DO NOTHING`,
      [event.id, `deploy:${event.id}`, JSON.stringify({ eventId: event.id })],
    );
  });

  await updateJob(job.id, 98, 'Snapshot ready; sponsored VoteEvent deployment queued');
  return {
    recordDateBlock: recordBlock.number,
    recordDateBlockHash: recordBlock.hash,
    snapshotRoot: tree.root,
    eligibleHolderCount: tree.entries.length,
    totalRawBalance: reconstructedSupply.toString(),
  };
}
