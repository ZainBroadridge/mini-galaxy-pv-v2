import { config } from './config.js';
import { db, query, transaction } from './db.js';

export async function claimJob() {
  return transaction(async (client) => {
    const result = await client.query(
      `WITH candidate AS (
         SELECT id FROM jobs
         WHERE status = 'PENDING' AND available_at <= now()
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs j SET
         status = 'RUNNING',
         attempts = attempts + 1,
         locked_at = now(),
         locked_by = $1,
         progress_message = COALESCE(progress_message, 'Running')
       FROM candidate c
       WHERE j.id = c.id
       RETURNING j.*`,
      [config.workerId],
    );
    return result.rows[0] ?? null;
  });
}

export async function updateJob(jobId, progress, progressMessage, resultPatch = undefined) {
  const current = await query('SELECT result FROM jobs WHERE id = $1', [jobId]);
  const merged = resultPatch === undefined
    ? current.rows[0]?.result ?? null
    : { ...(current.rows[0]?.result ?? {}), ...resultPatch };
  await query(
    `UPDATE jobs SET
       progress = $2,
       progress_message = $3,
       result = $4::jsonb,
       locked_at = CASE WHEN status = 'RUNNING' THEN now() ELSE locked_at END
     WHERE id = $1`,
    [jobId, progress, progressMessage, merged === null ? null : JSON.stringify(merged)],
  );
}

export async function renewJobLock(jobId) {
  await query(
    `UPDATE jobs SET locked_at = now()
     WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2`,
    [jobId, config.workerId],
  );
}

export async function completeJob(jobId, result = {}) {
  await query(
    `UPDATE jobs SET
       status = 'COMPLETED', progress = 100, progress_message = 'Completed',
       result = $2::jsonb, locked_at = NULL, locked_by = NULL, last_error = NULL
     WHERE id = $1`,
    [jobId, JSON.stringify(result)],
  );
}

function retryDelaySeconds(attempts) {
  return Math.min(300, 3 * (2 ** Math.max(0, attempts - 1)));
}

export async function failJob(job, error) {
  const message = String(error?.shortMessage ?? error?.reason ?? error?.message ?? error).slice(0, 4000);
  const finalFailure = Boolean(error?.permanent) || Number(job.attempts) >= Number(job.max_attempts);
  if (!finalFailure) {
    await query(
      `UPDATE jobs SET
         status = 'PENDING',
         available_at = now() + ($2 * interval '1 second'),
         locked_at = NULL, locked_by = NULL,
         progress_message = 'Retry scheduled', last_error = $3
       WHERE id = $1`,
      [job.id, retryDelaySeconds(job.attempts), message],
    );
    return false;
  }

  await transaction(async (client) => {
    await client.query(
      `UPDATE jobs SET
         status = 'FAILED', locked_at = NULL, locked_by = NULL,
         progress_message = 'Failed', last_error = $2
       WHERE id = $1`,
      [job.id, message],
    );
    if (job.job_type === 'BUILD_SNAPSHOT') {
      await client.query(
        `UPDATE events SET status = 'FAILED', failure_reason = $2 WHERE id = $1`,
        [job.event_id, message],
      );
    } else if (job.job_type === 'DEPLOY_EVENT') {
      await client.query(
        `UPDATE events SET
           status = CASE WHEN deployment_block IS NULL THEN 'SNAPSHOT_READY' ELSE status END,
           failure_reason = $2
         WHERE id = $1`,
        [job.event_id, message],
      );
    } else if (job.job_type === 'RELAY_VOTE') {
      await client.query(
        `UPDATE votes SET status = 'FAILED', failure_message = $3
         WHERE event_id = $1 AND voter_address = $2 AND status <> 'CONFIRMED'`,
        [job.event_id, job.voter_address, message],
      );
    } else if (job.job_type === 'VERIFY_CONTRACT') {
      await client.query(
        `UPDATE events SET
           source_verification_status = 'FAILED', source_verification_error = $2
         WHERE id = $1`,
        [job.event_id, message],
      );
    }
  });
  return true;
}

export async function recoverExpiredJobs() {
  await query(
    `UPDATE jobs SET
       status = 'PENDING', locked_at = NULL, locked_by = NULL,
       available_at = now(), progress_message = 'Recovered after worker interruption'
     WHERE status = 'RUNNING'
       AND locked_at < now() - ($1 * interval '1 minute')`,
    [config.jobLockMinutes],
  );
}

export async function withAdvisoryLock(lockName, callback) {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
    return await callback();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
    } finally {
      client.release();
    }
  }
}
