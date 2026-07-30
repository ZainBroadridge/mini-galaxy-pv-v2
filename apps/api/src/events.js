import { Contract } from 'ethers';
import {
  AUTHENTICITY_CLAIM,
  AUTHENTICITY_STATUS,
  DISCOVERY_MODE,
  VOTE_EVENT_ABI,
  canonicalEventMetadata,
  hashEventMetadata,
  packProposalConfig,
  tokenUnitsPerVote,
} from '@pv/shared';
import { config } from './config.js';
import { query, transaction } from './db.js';
import { HttpError, normalizeAddress } from './errors.js';
import { enqueueJob } from './jobs.js';
import { provider } from './provider.js';
import { effectiveStatus, serializeEvent, serializeJob, serializeVote } from './serializers.js';
import { inspectStandardToken } from './tokens.js';

export async function fetchEventRow(eventId, client = { query }) {
  const result = await client.query('SELECT * FROM events WHERE id = $1', [eventId]);
  if (!result.rowCount) throw new HttpError(404, 'Voting event not found.', 'EVENT_NOT_FOUND');
  return result.rows[0];
}

export async function listEventJobs(eventId, limit = 10) {
  const result = await query(
    `SELECT * FROM jobs WHERE event_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [eventId, limit],
  );
  return result.rows.map(serializeJob);
}

export async function latestEventJob(eventId) {
  const jobs = await listEventJobs(eventId, 1);
  return jobs[0] ?? null;
}

export async function createEvent(creatorAddress, input) {
  const creator = normalizeAddress(creatorAddress, 'creatorAddress');
  if (config.eventsPerWalletPerDay > 0) {
    const count = await query(
      `SELECT count(*)::integer AS count FROM events
       WHERE creator_address = $1 AND created_at > now() - interval '24 hours'`,
      [creator],
    );
    if (Number(count.rows[0].count) >= config.eventsPerWalletPerDay) {
      throw new HttpError(
        429,
        `This wallet has reached the ${config.eventsPerWalletPerDay}-event daily testnet limit.`,
        'EVENT_LIMIT_REACHED',
      );
    }
  }

  const token = await inspectStandardToken(input.tokenAddress);
  const metadata = canonicalEventMetadata(input);
  const metadataHash = hashEventMetadata(metadata).hash;
  const proposalConfig = packProposalConfig(
    metadata.proposals.map((proposal) => proposal.options.length),
  );
  const voteUnit = tokenUnitsPerVote(token.decimals, input.tokenToVoteRatio);

  let authenticityStatus = AUTHENTICITY_STATUS.COMMUNITY;
  if (input.authenticityClaim === AUTHENTICITY_CLAIM.ISSUER_AUTHORIZED) {
    authenticityStatus = token.optionalOwner === creator
      ? AUTHENTICITY_STATUS.TOKEN_OWNER_VERIFIED
      : AUTHENTICITY_STATUS.SELF_CLAIMED;
  }

  const row = await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO events (
         chain_id, creator_address, token_address, token_name, token_symbol, token_decimals,
         title, description, metadata_json, metadata_hash, proposal_config,
         record_date_at, token_to_vote_ratio, vote_unit, voting_start_at, voting_end_at,
         discovery_mode, authenticity_claim, authenticity_status, snap_delivery_mode, status
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'SNAPSHOT_PENDING'
       ) RETURNING *`,
      [
        config.chainId,
        creator,
        token.tokenAddress,
        token.name,
        token.symbol,
        token.decimals,
        metadata.title,
        metadata.description,
        JSON.stringify(metadata),
        metadataHash,
        proposalConfig.toString(),
        new Date(input.recordDateAt),
        input.tokenToVoteRatio,
        voteUnit.toString(),
        new Date(input.votingStartAt),
        new Date(input.votingEndAt),
        input.discoveryMode,
        input.authenticityClaim,
        authenticityStatus,
        input.snapDeliveryMode,
      ],
    );
    const event = inserted.rows[0];
    await enqueueJob({
      eventId: event.id,
      type: 'BUILD_SNAPSHOT',
      dedupeKey: `snapshot:${event.id}`,
      payload: { eventId: event.id },
      message: 'Queued for record-date snapshot',
      client,
    });
    return event;
  });

  return serializeEvent(row, {
    latestJob: await latestEventJob(row.id),
    jobs: await listEventJobs(row.id),
  });
}

export async function getEvent(eventId) {
  const [row, jobs] = await Promise.all([
    fetchEventRow(eventId),
    listEventJobs(eventId),
  ]);
  let contractMetadataHash = null;
  let contractMetadataIntegrity = null;
  if (row.contract_address && row.deployment_block !== null) {
    try {
      const contract = new Contract(row.contract_address, VOTE_EVENT_ABI, provider);
      contractMetadataHash = String(await contract.metadataHash()).toLowerCase();
      contractMetadataIntegrity = contractMetadataHash === String(row.metadata_hash).toLowerCase();
    } catch {
      // The page can still use the Neon projection while showing that the
      // additional on-chain metadata check is temporarily unavailable.
    }
  }
  return serializeEvent(row, {
    latestJob: jobs[0] ?? null,
    jobs,
    contractMetadataHash,
    contractMetadataIntegrity,
  });
}

export async function listPublicEvents(scope = 'ongoing') {
  const timeClause = scope === 'completed'
    ? 'e.voting_end_at < now()'
    : scope === 'all'
      ? 'true'
      : 'e.voting_end_at >= now()';
  const result = await query(
    `SELECT e.* FROM events e
     WHERE e.discovery_mode = $1
       AND e.contract_address IS NOT NULL
       AND e.deployment_block IS NOT NULL
       AND ${timeClause}
     ORDER BY CASE WHEN e.voting_end_at >= now() THEN 0 ELSE 1 END,
              e.voting_end_at ASC, e.created_at DESC
     LIMIT 200`,
    [DISCOVERY_MODE.PUBLIC_ELIGIBLE],
  );
  return result.rows.map((row) => serializeEvent(row));
}

export async function listCreatedEvents(walletAddress) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const result = await query(
    `SELECT * FROM events WHERE creator_address = $1 ORDER BY created_at DESC LIMIT 200`,
    [wallet],
  );
  return Promise.all(
    result.rows.map(async (row) => serializeEvent(row, {
      latestJob: await latestEventJob(row.id),
    })),
  );
}

export async function listEligibleEvents(walletAddress, scope = 'ongoing') {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const timeClause = scope === 'completed'
    ? 'e.voting_end_at < now()'
    : scope === 'all'
      ? 'true'
      : 'e.voting_end_at >= now()';

  const result = await query(
    `SELECT e.*, se.raw_balance, se.voting_power,
            v.status AS vote_status, v.transaction_hash,
            ss.status AS subscription_status
     FROM snapshot_entries se
     JOIN events e ON e.id = se.event_id
     LEFT JOIN votes v ON v.event_id = e.id AND v.voter_address = $1
     LEFT JOIN snap_subscriptions ss
       ON ss.wallet_address = $1
      AND ss.chain_id = e.chain_id
      AND ss.token_address = e.token_address
      AND ss.status = 'ACTIVE'
     WHERE se.wallet_address = $1
       AND e.contract_address IS NOT NULL
       AND e.deployment_block IS NOT NULL
       AND ${timeClause}
       AND (
         e.discovery_mode = 'PUBLIC_ELIGIBLE'
         OR (e.discovery_mode = 'SUBSCRIBERS_ONLY' AND ss.wallet_address IS NOT NULL)
       )
     ORDER BY e.voting_end_at ASC, e.created_at DESC
     LIMIT 200`,
    [wallet],
  );

  return result.rows.map((row) => serializeEvent(row, {
    eligibility: {
      eligible: true,
      canVote: BigInt(row.voting_power) > 0n,
      rawBalance: String(row.raw_balance),
      votingPower: String(row.voting_power),
      hasVoted: Boolean(row.vote_status),
      voteStatus: row.vote_status ?? null,
      transactionHash: row.transaction_hash ?? null,
    },
  }));
}

export async function getEligibility(eventId, walletAddress) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const event = await fetchEventRow(eventId);
  const [snapshotResult, voteResult] = await Promise.all([
    query(
      `SELECT * FROM snapshot_entries WHERE event_id = $1 AND wallet_address = $2`,
      [eventId, wallet],
    ),
    query(`SELECT * FROM votes WHERE event_id = $1 AND voter_address = $2`, [eventId, wallet]),
  ]);

  let onchainHasVoted = false;
  if (event.contract_address && event.deployment_block !== null) {
    try {
      const contract = new Contract(event.contract_address, VOTE_EVENT_ABI, provider);
      onchainHasVoted = await contract.hasVoted(wallet);
    } catch {
      // Neon remains available while an RPC endpoint is temporarily unavailable.
    }
  }

  const snapshot = snapshotResult.rows[0];
  const vote = voteResult.rows[0];
  const hasVoted = onchainHasVoted || Boolean(vote);
  return {
    eventId,
    walletAddress: wallet,
    eligible: Boolean(snapshot),
    canVote: Boolean(snapshot) && BigInt(snapshot.voting_power) > 0n,
    rawBalance: snapshot ? String(snapshot.raw_balance) : '0',
    votingPower: snapshot ? String(snapshot.voting_power) : '0',
    merkleProof: snapshot?.merkle_proof ?? [],
    hasVoted,
    vote: serializeVote(vote, event),
    event: serializeEvent(event),
    eventStatus: effectiveStatus(event),
  };
}

export async function assertEventCreator(eventId, walletAddress) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const event = await fetchEventRow(eventId);
  if (event.creator_address !== wallet) {
    throw new HttpError(403, 'Only the event creator can perform this action.', 'CREATOR_REQUIRED');
  }
  return event;
}

function assertReadyForDeployment(event) {
  if (event.deployment_block !== null) {
    throw new HttpError(409, 'This event already has a mined VoteEvent contract.', 'EVENT_ALREADY_DEPLOYED');
  }
  if (!event.snapshot_root || event.record_date_block === null) {
    throw new HttpError(409, 'The record-date snapshot is not ready yet.', 'SNAPSHOT_NOT_READY');
  }
  if (new Date(event.voting_end_at).getTime() <= Date.now()) {
    throw new HttpError(409, 'Voting has already ended.', 'EVENT_EXPIRED');
  }
}

export async function retryDeployment(eventId, walletAddress) {
  const event = await assertEventCreator(eventId, walletAddress);
  assertReadyForDeployment(event);
  const job = await transaction(async (client) => {
    await client.query(
      `UPDATE events SET status = 'DEPLOYMENT_QUEUED', failure_reason = NULL WHERE id = $1`,
      [event.id],
    );
    return enqueueJob({
      eventId: event.id,
      type: 'DEPLOY_EVENT',
      dedupeKey: `deploy:${event.id}`,
      payload: { eventId: event.id },
      message: 'Sponsored one-contract deployment retry queued',
      client,
    });
  });
  return {
    event: serializeEvent({ ...event, status: 'DEPLOYMENT_QUEUED', failure_reason: null }),
    job: serializeJob(job),
  };
}

export async function retrySnapshot(eventId, walletAddress) {
  const event = await assertEventCreator(eventId, walletAddress);
  if (event.contract_address) {
    throw new HttpError(409, 'A deployed event cannot rebuild its immutable snapshot.', 'EVENT_ALREADY_DEPLOYED');
  }
  const job = await transaction(async (client) => {
    await client.query(
      `UPDATE events SET status = 'SNAPSHOT_PENDING', failure_reason = NULL WHERE id = $1`,
      [event.id],
    );
    return enqueueJob({
      eventId: event.id,
      type: 'BUILD_SNAPSHOT',
      dedupeKey: `snapshot:${event.id}`,
      payload: { eventId: event.id },
      message: 'Snapshot retry queued',
      client,
    });
  });
  return { job: serializeJob(job) };
}
