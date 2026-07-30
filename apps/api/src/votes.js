import { Contract, verifyTypedData } from 'ethers';
import { VOTE_EVENT_ABI, ballotTypedData, hashEventMetadata } from '@pv/shared';
import { query, transaction } from './db.js';
import { HttpError, normalizeAddress } from './errors.js';
import { fetchEventRow, getEligibility } from './events.js';
import { enqueueJob } from './jobs.js';
import { provider } from './provider.js';
import { effectiveStatus, serializeEvent, serializeJob, serializeVote } from './serializers.js';


function unixSeconds(value) {
  return BigInt(Math.floor(new Date(value).getTime() / 1000));
}

async function assertEventIntegrity(event) {
  let canonicalHash;
  try {
    canonicalHash = hashEventMetadata(event.metadata_json).hash.toLowerCase();
  } catch {
    throw new HttpError(
      409,
      'Event proposal metadata is not canonical. Voting is blocked.',
      'EVENT_METADATA_INVALID',
    );
  }
  if (canonicalHash !== String(event.metadata_hash).toLowerCase()) {
    throw new HttpError(
      409,
      'Neon proposal metadata no longer matches its committed hash. Voting is blocked.',
      'EVENT_METADATA_MISMATCH',
    );
  }

  const contract = new Contract(event.contract_address, VOTE_EVENT_ABI, provider);
  let actual;
  try {
    actual = await Promise.all([
      contract.creator(),
      contract.tokenAddress(),
      contract.snapshotBlock(),
      contract.snapshotRoot(),
      contract.votingStart(),
      contract.votingEnd(),
      contract.voteUnit(),
      contract.metadataHash(),
      contract.proposalConfig(),
    ]);
  } catch {
    throw new HttpError(
      503,
      'The VoteEvent integrity check is temporarily unavailable from Polygon Amoy.',
      'EVENT_INTEGRITY_UNAVAILABLE',
    );
  }

  const matches =
    String(actual[0]).toLowerCase() === String(event.creator_address).toLowerCase()
    && String(actual[1]).toLowerCase() === String(event.token_address).toLowerCase()
    && actual[2] === BigInt(event.record_date_block)
    && String(actual[3]).toLowerCase() === String(event.snapshot_root).toLowerCase()
    && actual[4] === unixSeconds(event.voting_start_at)
    && actual[5] === unixSeconds(event.voting_end_at)
    && actual[6] === BigInt(event.vote_unit)
    && String(actual[7]).toLowerCase() === String(event.metadata_hash).toLowerCase()
    && actual[8] === BigInt(event.proposal_config);

  if (!matches) {
    throw new HttpError(
      409,
      'The Neon event configuration does not match the deployed VoteEvent. Voting is blocked.',
      'EVENT_CONTRACT_MISMATCH',
    );
  }
}

function validateChoices(event, choices) {
  const proposals = event.metadata_json?.proposals ?? [];
  if (choices.length !== proposals.length) {
    throw new HttpError(400, 'Select one option for every proposal.', 'INCOMPLETE_BALLOT');
  }
  choices.forEach((choice, index) => {
    if (!Number.isInteger(choice) || choice < 0 || choice >= proposals[index].options.length) {
      throw new HttpError(400, `Proposal ${index + 1} contains an invalid option.`, 'INVALID_CHOICE');
    }
  });
}

export async function prepareBallot(eventId, walletAddress, choices) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const event = await fetchEventRow(eventId);
  if (!event.contract_address || event.deployment_block === null) {
    throw new HttpError(409, 'The VoteEvent contract is not deployed yet.', 'EVENT_NOT_DEPLOYED');
  }
  await assertEventIntegrity(event);
  if (effectiveStatus(event) !== 'OPEN') {
    throw new HttpError(409, 'Voting is not currently open.', 'VOTING_NOT_OPEN');
  }
  validateChoices(event, choices);

  const eligibility = await getEligibility(eventId, wallet);
  if (!eligibility.eligible) {
    throw new HttpError(403, 'This wallet held no tokens at the record date.', 'NOT_IN_SNAPSHOT');
  }
  if (!eligibility.canVote) {
    throw new HttpError(
      403,
      'This wallet has less than one complete voting unit under the selected token-to-vote ratio.',
      'ZERO_VOTING_POWER',
    );
  }
  if (eligibility.hasVoted) {
    throw new HttpError(409, 'This wallet has already submitted its final ballot.', 'ALREADY_VOTED');
  }

  const typed = ballotTypedData({
    chainId: event.chain_id,
    contractAddress: event.contract_address,
    voter: wallet,
    choices,
  });

  return {
    eventId,
    contractAddress: event.contract_address,
    snapshotBalance: eligibility.rawBalance,
    votingPower: eligibility.votingPower,
    merkleProof: eligibility.merkleProof,
    choices,
    choicesBytes: typed.choicesBytes,
    typedData: {
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    },
  };
}

export async function submitBallot(eventId, walletAddress, choices, signature) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const ballot = await prepareBallot(eventId, wallet, choices);

  let recovered;
  try {
    recovered = normalizeAddress(verifyTypedData(
      ballot.typedData.domain,
      ballot.typedData.types,
      ballot.typedData.message,
      signature,
    ));
  } catch {
    throw new HttpError(401, 'The ballot signature is invalid.', 'INVALID_BALLOT_SIGNATURE');
  }
  if (recovered !== wallet) {
    throw new HttpError(401, 'The ballot signature belongs to a different wallet.', 'BALLOT_SIGNER_MISMATCH');
  }

  const result = await transaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`ballot:${eventId}:${wallet}`],
    );
    const existing = await client.query(
      `SELECT * FROM votes WHERE event_id = $1 AND voter_address = $2 FOR UPDATE`,
      [eventId, wallet],
    );
    if (existing.rowCount) {
      throw new HttpError(
        409,
        'This wallet already submitted its final signed ballot. Retry the existing submission instead of changing it.',
        'FINAL_BALLOT_EXISTS',
      );
    }

    const inserted = await client.query(
      `INSERT INTO votes (
         event_id, voter_address, snapshot_balance, voting_power,
         choices, choices_hex, voter_signature, status
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'QUEUED')
       RETURNING *`,
      [
        eventId,
        wallet,
        ballot.snapshotBalance,
        ballot.votingPower,
        JSON.stringify(choices),
        ballot.choicesBytes,
        signature,
      ],
    );
    const vote = inserted.rows[0];

    const job = await enqueueJob({
      eventId,
      voterAddress: wallet,
      type: 'RELAY_VOTE',
      dedupeKey: `vote:${eventId}:${wallet}`,
      payload: { eventId, voter: wallet },
      message: 'Queued for gasless submission',
      client,
    });
    return { vote, job };
  });

  const event = await fetchEventRow(eventId);
  return {
    vote: serializeVote(result.vote, event),
    job: serializeJob(result.job),
  };
}

export async function retryBallot(eventId, walletAddress) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const event = await fetchEventRow(eventId);
  if (!event.contract_address || event.deployment_block === null) {
    throw new HttpError(409, 'The VoteEvent contract is not deployed yet.', 'EVENT_NOT_DEPLOYED');
  }
  if (Date.now() > new Date(event.voting_end_at).getTime()) {
    throw new HttpError(409, 'The voting window has ended.', 'VOTING_ENDED');
  }

  const result = await transaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`ballot:${eventId}:${wallet}`],
    );
    const existing = await client.query(
      `SELECT * FROM votes WHERE event_id = $1 AND voter_address = $2 FOR UPDATE`,
      [eventId, wallet],
    );
    if (!existing.rowCount) {
      throw new HttpError(404, 'No signed ballot exists to retry.', 'BALLOT_NOT_FOUND');
    }
    if (existing.rows[0].status === 'CONFIRMED') {
      throw new HttpError(409, 'This ballot is already confirmed on-chain.', 'ALREADY_VOTED');
    }

    const updated = await client.query(
      `UPDATE votes SET
         status = CASE WHEN transaction_hash IS NULL THEN 'QUEUED' ELSE 'SUBMITTED' END,
         failure_message = NULL
       WHERE event_id = $1 AND voter_address = $2
       RETURNING *`,
      [eventId, wallet],
    );
    const job = await enqueueJob({
      eventId,
      voterAddress: wallet,
      type: 'RELAY_VOTE',
      dedupeKey: `vote:${eventId}:${wallet}`,
      payload: { eventId, voter: wallet },
      message: 'Existing final ballot queued for another relayer attempt',
      client,
    });
    return { vote: updated.rows[0], job };
  });

  return {
    vote: serializeVote(result.vote, event),
    job: serializeJob(result.job),
  };
}

export async function getVote(eventId, walletAddress) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const [event, result] = await Promise.all([
    fetchEventRow(eventId),
    query(`SELECT * FROM votes WHERE event_id = $1 AND voter_address = $2`, [eventId, wallet]),
  ]);
  return serializeVote(result.rows[0], event);
}

export async function getResults(eventId) {
  const event = await fetchEventRow(eventId);
  if (!event.contract_address || event.deployment_block === null) {
    throw new HttpError(409, 'The VoteEvent contract is not deployed yet.', 'EVENT_NOT_DEPLOYED');
  }
  await assertEventIntegrity(event);
  if (Date.now() <= new Date(event.voting_end_at).getTime()) {
    return { available: false, event: serializeEvent(event), proposals: [] };
  }

  const contract = new Contract(event.contract_address, VOTE_EVENT_ABI, provider);
  const proposals = await Promise.all(
    event.metadata_json.proposals.map(async (proposal, proposalIndex) => {
      const rawTallies = await contract.getProposalTallies(proposalIndex);
      const tallies = rawTallies.map((value) => value.toString());
      const totalVotingPower = rawTallies.reduce((total, value) => total + value, 0n).toString();
      return { ...proposal, tallies, totalVotingPower };
    }),
  );
  return { available: true, event: serializeEvent(event), proposals };
}
