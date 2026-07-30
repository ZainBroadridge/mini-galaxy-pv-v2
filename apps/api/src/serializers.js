import { hashEventMetadata } from '@pv/shared';
import { config } from './config.js';

export function effectiveStatus(row) {
  if (!row.contract_address || row.deployment_block === null) return row.status;
  const now = Date.now();
  if (now < new Date(row.voting_start_at).getTime()) return 'SCHEDULED';
  if (now <= new Date(row.voting_end_at).getTime()) return 'OPEN';
  return 'CLOSED';
}

export function serializeEvent(row, extras = {}) {
  if (!row) return null;
  let metadataIntegrity = false;
  try {
    metadataIntegrity = hashEventMetadata(row.metadata_json).hash.toLowerCase()
      === String(row.metadata_hash).toLowerCase();
  } catch {
    metadataIntegrity = false;
  }

  return {
    id: row.id,
    chainId: Number(row.chain_id),
    creatorAddress: row.creator_address,
    tokenAddress: row.token_address,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    tokenDecimals: Number(row.token_decimals),
    title: row.title,
    description: row.description,
    metadata: row.metadata_json,
    metadataHash: row.metadata_hash,
    metadataIntegrity,
    proposalConfig: String(row.proposal_config),
    recordDateAt: row.record_date_at,
    recordDateBlock: row.record_date_block === null ? null : Number(row.record_date_block),
    recordDateBlockHash: row.record_date_block_hash,
    snapshotRoot: row.snapshot_root,
    snapshotHolderCount: row.snapshot_holder_count === null ? null : Number(row.snapshot_holder_count),
    snapshotTotalBalance: row.snapshot_total_balance === null ? null : String(row.snapshot_total_balance),
    tokenToVoteRatio: Number(row.token_to_vote_ratio),
    voteUnit: String(row.vote_unit),
    votingStartAt: row.voting_start_at,
    votingEndAt: row.voting_end_at,
    discoveryMode: row.discovery_mode,
    authenticityClaim: row.authenticity_claim,
    authenticityStatus: row.authenticity_status,
    snapDeliveryMode: row.snap_delivery_mode,
    status: effectiveStatus(row),
    storedStatus: row.status,
    failureReason: row.failure_reason,
    contractAddress: row.contract_address,
    deploymentTransactionHash: row.deployment_tx_hash,
    deploymentBlock: row.deployment_block === null ? null : Number(row.deployment_block),
    sourceVerificationStatus: row.source_verification_status,
    sourceVerificationUrl: row.source_verification_url,
    sourceVerificationError: row.source_verification_error,
    contractExplorerUrl: row.contract_address ? `${config.explorerUrl}/address/${row.contract_address}#code` : null,
    deploymentExplorerUrl: row.deployment_tx_hash ? `${config.explorerUrl}/tx/${row.deployment_tx_hash}` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extras,
  };
}

export function serializeJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    voterAddress: row.voter_address,
    type: row.job_type,
    status: row.status,
    progress: Number(row.progress),
    progressMessage: row.progress_message,
    result: row.result,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeVote(row, event = null) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    voterAddress: row.voter_address,
    snapshotBalance: String(row.snapshot_balance),
    votingPower: String(row.voting_power),
    choices: row.choices,
    choicesHex: row.choices_hex,
    status: row.status,
    transactionHash: row.transaction_hash,
    transactionExplorerUrl: row.transaction_hash ? `${config.explorerUrl}/tx/${row.transaction_hash}` : null,
    contractAddress: event?.contract_address ?? null,
    contractExplorerUrl: event?.contract_address ? `${config.explorerUrl}/address/${event.contract_address}#code` : null,
    sourceVerificationStatus: event?.source_verification_status ?? null,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
    updatedAt: row.updated_at,
  };
}
