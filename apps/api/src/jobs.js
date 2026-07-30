import { query } from './db.js';
import { HttpError } from './errors.js';
import { serializeJob } from './serializers.js';

export async function enqueueJob({
  eventId,
  voterAddress = null,
  type,
  dedupeKey,
  payload = {},
  message = 'Queued',
  client = { query },
}) {
  const active = await client.query(
    `SELECT * FROM jobs
     WHERE dedupe_key = $1 AND status IN ('PENDING','RUNNING')
     ORDER BY created_at DESC LIMIT 1`,
    [dedupeKey],
  );
  if (active.rowCount) return active.rows[0];

  // Reuse a failed job so any signed raw relayer transaction attached to it can
  // be safely rebroadcast instead of generating another deployment or nonce.
  const failed = await client.query(
    `SELECT * FROM jobs
     WHERE dedupe_key = $1 AND status = 'FAILED'
     ORDER BY created_at DESC LIMIT 1
     FOR UPDATE`,
    [dedupeKey],
  );
  if (failed.rowCount) {
    const reset = await client.query(
      `UPDATE jobs SET
         event_id = $2,
         voter_address = $3,
         job_type = $4,
         payload = $5::jsonb,
         status = 'PENDING',
         progress = 0,
         progress_message = $6,
         result = NULL,
         attempts = 0,
         available_at = now(),
         locked_at = NULL,
         locked_by = NULL,
         last_error = NULL
       WHERE id = $1
       RETURNING *`,
      [
        failed.rows[0].id,
        eventId,
        voterAddress,
        type,
        JSON.stringify(payload),
        message,
      ],
    );
    return reset.rows[0];
  }

  const inserted = await client.query(
    `INSERT INTO jobs (
       event_id, voter_address, job_type, dedupe_key, payload, progress_message
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [eventId, voterAddress, type, dedupeKey, JSON.stringify(payload), message],
  );
  if (inserted.rowCount) return inserted.rows[0];

  const raced = await client.query(
    `SELECT * FROM jobs
     WHERE dedupe_key = $1 AND status IN ('PENDING','RUNNING')
     ORDER BY created_at DESC LIMIT 1`,
    [dedupeKey],
  );
  if (!raced.rowCount) {
    throw new HttpError(409, 'A matching job could not be queued.', 'JOB_QUEUE_CONFLICT');
  }
  return raced.rows[0];
}

export async function getJob(jobId) {
  const result = await query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (!result.rowCount) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
  return serializeJob(result.rows[0]);
}
