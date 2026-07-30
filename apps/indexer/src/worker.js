import { assertConfig, config } from './config.js';
import { db, query } from './db.js';
import { logger } from './logger.js';
import { claimJob, completeJob, failJob, recoverExpiredJobs, renewJobLock } from './queue.js';
import { buildSnapshot } from './snapshot.js';
import { deployEvent } from './deploy.js';
import { relayVote } from './vote.js';
import { verifyContract } from './verify.js';
import { indexVoteEvents, reconcileSubmittedVotes } from './event-indexer.js';
import { errorText, sleep } from './utils.js';
import { provider, relayer } from './provider.js';
import http from 'node:http';

let stopping = false;
const inFlight = new Set();

const port = Number(process.env.PORT || 10000);

const healthServer = http.createServer((request, response) => {
  if (request.url === '/' || request.url === '/health') {
    response.writeHead(200, {
      'Content-Type': 'application/json',
    });

    response.end(JSON.stringify({
      ok: true,
      service: 'pv-v2-indexer',
      workerId: config.workerId,
      stopping,
      activeJobs: inFlight.size,
      timestamp: new Date().toISOString(),
    }));

    return;
  }

  response.writeHead(404, {
    'Content-Type': 'application/json',
  });

  response.end(JSON.stringify({
    error: 'Not found',
  }));
});

healthServer.listen(port, '0.0.0.0', () => {
  logger.info({ port }, 'Indexer health server listening');
});

async function heartbeat(details = {}) {
  let balance = null;
  let latestBlock = null;
  try {
    [balance, latestBlock] = await Promise.all([
      provider.getBalance(relayer.address),
      provider.getBlockNumber(),
    ]);
  } catch {
    // Database liveness remains visible during a temporary RPC outage.
  }
  await query(
    `INSERT INTO worker_heartbeats(worker_id, worker_type, details, last_seen_at)
     VALUES ($1, 'INDEXER', $2::jsonb, now())
     ON CONFLICT(worker_id) DO UPDATE SET
       details = EXCLUDED.details,
       last_seen_at = now()`,
    [
      config.workerId,
      JSON.stringify({
        ...details,
        activeJobs: inFlight.size,
        relayerAddress: relayer.address.toLowerCase(),
        relayerBalanceWei: balance?.toString() ?? null,
        latestBlock,
      }),
    ],
  );
}

async function executeJob(job) {
  switch (job.job_type) {
    case 'BUILD_SNAPSHOT': return buildSnapshot(job);
    case 'DEPLOY_EVENT': return deployEvent(job);
    case 'RELAY_VOTE': return relayVote(job);
    case 'VERIFY_CONTRACT': return verifyContract(job);
    default: throw new Error(`Unsupported job type: ${job.job_type}`);
  }
}

async function runClaimedJob(job) {
  logger.info({ jobId: job.id, type: job.job_type, eventId: job.event_id }, 'Processing job');
  const renewalMs = Math.max(15_000, Math.min(60_000, Math.floor(config.jobLockMinutes * 20_000)));
  const renewal = setInterval(() => {
    renewJobLock(job.id).catch((error) => {
      logger.warn({ jobId: job.id, error: errorText(error) }, 'Could not renew job lock');
    });
  }, renewalMs);
  renewal.unref?.();
  try {
    const result = await executeJob(job);
    await completeJob(job.id, result);
    logger.info({ jobId: job.id, type: job.job_type }, 'Job completed');
  } catch (error) {
    await failJob(job, error);
    logger.warn(
      { jobId: job.id, type: job.job_type, error: errorText(error) },
      'Job failed or was scheduled for retry',
    );
  } finally {
    clearInterval(renewal);
  }
}

async function fillAvailableSlots() {
  let claimedAny = false;
  while (!stopping && inFlight.size < config.jobConcurrency) {
    const job = await claimJob();
    if (!job) break;
    claimedAny = true;
    let task;
    task = runClaimedJob(job).finally(() => inFlight.delete(task));
    inFlight.add(task);
  }
  return claimedAny;
}

async function maintenance() {
  try {
    await indexVoteEvents();
    await reconcileSubmittedVotes();
  } catch (error) {
    logger.error({ error: errorText(error) }, 'Blockchain indexing pass failed');
  }
}

async function run() {
  assertConfig();
  logger.info(
    {
      workerId: config.workerId,
      chainId: config.chainId,
      relayer: relayer.address.toLowerCase(),
      concurrency: config.jobConcurrency,
    },
    'PV V2 worker starting',
  );
  await recoverExpiredJobs();
  let maintenanceAt = 0;
  let recoveryAt = Date.now() + 60_000;
  let heartbeatAt = 0;

  while (!stopping) {
    const claimed = await fillAvailableSlots().catch((error) => {
      logger.error({ error: errorText(error) }, 'Job claim loop failed');
      return false;
    });
    if (Date.now() >= maintenanceAt) {
      await maintenance();
      maintenanceAt = Date.now() + 5_000;
    }
    if (Date.now() >= recoveryAt) {
      await recoverExpiredJobs();
      recoveryAt = Date.now() + 60_000;
    }
    if (Date.now() >= heartbeatAt) {
      await heartbeat({ lastLoopAt: new Date().toISOString() });
      heartbeatAt = Date.now() + 10_000;
    }

    if (inFlight.size >= config.jobConcurrency) {
      await Promise.race(inFlight);
    } else if (!claimed) {
      if (inFlight.size) {
        await Promise.race([Promise.race(inFlight), sleep(config.pollIntervalMs)]);
      } else {
        await sleep(config.pollIntervalMs);
      }
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;

  stopping = true;
  logger.info({ signal }, 'Worker shutting down');

  await Promise.allSettled([...inFlight]);

  await new Promise((resolve) => {
    healthServer.close(() => resolve());
  });

  await db.end();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

run().catch(async (error) => {
  logger.fatal({ error: errorText(error) }, 'Worker terminated unexpectedly');
  await db.end();
  process.exit(1);
});
