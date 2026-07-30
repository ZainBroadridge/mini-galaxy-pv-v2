import { Contract, ContractFactory } from 'ethers';
import { VOTE_EVENT_ABI } from '@pv/shared';
import { config } from './config.js';
import { provider } from './provider.js';
import { loadVoteEventArtifact } from './artifact.js';
import { query, transaction } from './db.js';
import { updateJob } from './queue.js';
import {
  broadcastPreparedTransaction,
  prepareRelayerTransaction,
} from './relayer-transaction.js';
import { permanentError } from './utils.js';

function contractArguments(event) {
  return [
    event.creator_address,
    event.token_address,
    Number(event.record_date_block),
    event.snapshot_root,
    Math.floor(new Date(event.voting_start_at).getTime() / 1000),
    Math.floor(new Date(event.voting_end_at).getTime() / 1000),
    BigInt(event.vote_unit),
    event.metadata_hash,
    BigInt(event.proposal_config),
  ];
}

function lifecycleStatus(event) {
  const now = Date.now();
  if (now < new Date(event.voting_start_at).getTime()) return 'SCHEDULED';
  if (now <= new Date(event.voting_end_at).getTime()) return 'OPEN';
  return 'CLOSED';
}

async function validateContract(event, address) {
  const contract = new Contract(address, VOTE_EVENT_ABI, provider);
  const actual = await Promise.all([
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
  const expected = contractArguments(event);
  const same =
    String(actual[0]).toLowerCase() === String(expected[0]).toLowerCase()
    && String(actual[1]).toLowerCase() === String(expected[1]).toLowerCase()
    && actual[2] === BigInt(expected[2])
    && String(actual[3]).toLowerCase() === String(expected[3]).toLowerCase()
    && actual[4] === BigInt(expected[4])
    && actual[5] === BigInt(expected[5])
    && actual[6] === BigInt(expected[6])
    && String(actual[7]).toLowerCase() === String(expected[7]).toLowerCase()
    && actual[8] === BigInt(expected[8]);
  if (!same) {
    throw permanentError('Deployed VoteEvent state does not match the Neon event configuration.');
  }
}

async function finalizeDeployment(event, transactionHash, contractAddress, receipt) {
  if (Number(receipt.status) !== 1) throw permanentError('VoteEvent deployment reverted.');
  const code = await provider.getCode(contractAddress);
  if (code === '0x') throw permanentError('Deployment receipt succeeded but no contract bytecode was found.');
  await validateContract(event, contractAddress);
  const block = await provider.getBlock(receipt.blockNumber);
  const status = lifecycleStatus(event);

  await transaction(async (client) => {
    await client.query(
      `UPDATE events SET
         contract_address = $2,
         deployment_tx_hash = $3,
         deployment_block = $4,
         deployment_block_hash = $5,
         status = $6,
         failure_reason = NULL
       WHERE id = $1`,
      [
        event.id,
        contractAddress.toLowerCase(),
        transactionHash,
        receipt.blockNumber,
        block?.hash ?? receipt.blockHash,
        status,
      ],
    );
    await client.query(
      `INSERT INTO event_index_state(event_id, last_scanned_block, last_scanned_block_hash)
       VALUES ($1, $2, NULL)
       ON CONFLICT(event_id) DO NOTHING`,
      [event.id, Math.max(0, receipt.blockNumber - 1)],
    );
    if (config.verifyContracts && config.polygonScanApiKey) {
      await client.query(
        `INSERT INTO jobs(event_id, job_type, dedupe_key, payload, progress_message)
         VALUES ($1, 'VERIFY_CONTRACT', $2, $3::jsonb, 'Source verification queued')
         ON CONFLICT DO NOTHING`,
        [
          event.id,
          `verify:${event.id}`,
          JSON.stringify({ contractAddress: contractAddress.toLowerCase() }),
        ],
      );
      await client.query(
        `UPDATE events SET source_verification_status = 'PENDING' WHERE id = $1`,
        [event.id],
      );
    }
  });

  return {
    eventId: event.id,
    transactionHash,
    contractAddress: contractAddress.toLowerCase(),
    blockNumber: receipt.blockNumber,
    transactionExplorerUrl: `${config.explorerUrl}/tx/${transactionHash}`,
    contractExplorerUrl: `${config.explorerUrl}/address/${contractAddress}#code`,
  };
}

export async function deployEvent(job) {
  const result = await query('SELECT * FROM events WHERE id = $1', [job.event_id]);
  if (!result.rowCount) throw permanentError('Event no longer exists.');
  const event = result.rows[0];
  if (event.contract_address && event.deployment_block !== null) {
    return {
      alreadyDeployed: true,
      contractAddress: event.contract_address,
      transactionHash: event.deployment_tx_hash,
    };
  }
  if (!event.snapshot_root || event.record_date_block === null) {
    throw permanentError('A VoteEvent cannot be deployed before its snapshot is ready.');
  }
  if (new Date(event.voting_end_at).getTime() <= Date.now()) {
    throw permanentError('Voting ended before deployment could complete.');
  }

  const artifact = await loadVoteEventArtifact();
  const factory = new ContractFactory(artifact.abi, artifact.bytecode);
  const deploymentRequest = await factory.getDeployTransaction(...contractArguments(event));

  await updateJob(job.id, 10, 'Preparing and durably recording the single VoteEvent deployment');
  const prepared = await prepareRelayerTransaction({
    job,
    eventId: event.id,
    transactionType: 'DEPLOY_EVENT',
    request: deploymentRequest,
    predictContractAddress: true,
    onPrepared: async (client, transactionRow) => {
      await client.query(
        `UPDATE events SET
           status = 'DEPLOYING',
           deployment_tx_hash = $2,
           contract_address = $3,
           failure_reason = NULL
         WHERE id = $1`,
        [
          event.id,
          transactionRow.transaction_hash,
          transactionRow.predicted_contract_address,
        ],
      );
    },
  });

  await updateJob(job.id, 42, 'Broadcasting the persisted deployment transaction', {
    transactionHash: prepared.transaction_hash,
    contractAddress: prepared.predicted_contract_address,
  });
  const receipt = await broadcastPreparedTransaction(prepared, config.confirmations);
  await updateJob(job.id, 78, 'Validating deployed immutable configuration');
  const contractAddress = receipt.contractAddress
    ?? prepared.predicted_contract_address
    ?? event.contract_address;
  if (!contractAddress) throw permanentError('The deployment contract address is unavailable.');
  return finalizeDeployment(event, prepared.transaction_hash, contractAddress, receipt);
}
