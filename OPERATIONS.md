# Operations guide

## 1. Relayer wallet

Use a dedicated Amoy-only wallet. The relayer pays for:

- one `VoteEvent` deployment per event;
- one final `castVote` transaction per participating wallet.

Store `RELAYER_PRIVATE_KEY` only in the Render background worker. Do not add it to Vercel, GitHub, browser code, any `VITE_` variable, the Snap package, screenshots, or logs.

Monitor the relayer balance and establish a low-balance alert before a wider test.

## 2. Sponsored-action controls

The API/worker include:

- signed wallet authentication;
- rate limiting;
- configurable daily event limit per wallet;
- one deduplicated snapshot/deployment/vote job per logical action;
- crash-safe signed-transaction outbox;
- preflight validation and receipt reconciliation.

For a public test, add stronger spending limits, organization quotas, abuse detection, alerts and an emergency worker stop procedure.

## 3. Worker monitoring

`GET /health` includes the latest worker heartbeat.

Alert when:

```text
worker heartbeat is stale
RPC latest block stops advancing
relayer balance is below reserve
job failures increase
old snapshot/deployment/vote jobs remain queued
```

Useful SQL:

```sql
SELECT job_type, status, count(*)
FROM jobs
GROUP BY job_type, status
ORDER BY job_type, status;
```

```sql
SELECT id, event_id, job_type, attempts, last_error, updated_at
FROM jobs
WHERE status = 'FAILED'
ORDER BY updated_at DESC
LIMIT 50;
```

```sql
SELECT worker_id, details, last_seen_at
FROM worker_heartbeats
ORDER BY last_seen_at DESC;
```

## 4. Snapshot performance

Snapshot duration depends on token age/activity, RPC log limits, candidate count and archive-call performance.

Tune carefully:

```text
TRANSFER_LOG_CHUNK_SIZE
BALANCE_CALL_CONCURRENCY
JOB_CONCURRENCY
MAX_SNAPSHOT_CANDIDATES
TOKEN_SCAN_START_BLOCK
```

Higher concurrency can become slower when the provider throttles requests.

Repeat events for the same token reuse `token_index_cursors` and `token_holder_candidates`, avoiding a full rescan from genesis.

## 5. Token compatibility failures

A token is rejected when reconstructed positive balances do not equal historical `totalSupply`.

Common causes:

- rebasing/reflection balance changes;
- incomplete or nonstandard Transfer events;
- archive provider missing historical state;
- provider log-range failures;
- unusual proxy/code history;
- nonstandard token accounting.

Do not bypass the equality check simply to force a snapshot through.

## 6. Deployment transaction recovery

The worker signs and stores the raw deployment transaction before broadcasting. On retry, it rebroadcasts/reconciles the same transaction instead of constructing a second deployment.

When a deployment appears stuck:

1. Check the stored hash on Amoy PolygonScan.
2. Check the relayer pending nonce.
3. Keep the event locked while the transaction may still mine.
4. Do not manually queue a second deployment unless the first transaction is definitively replaced/dropped and the outbox is deliberately resolved.

## 7. Vote transaction recovery

A submitted vote remains locked while the transaction is pending. The event indexer can later confirm the vote from `VoteCast` even after an API/worker restart.

A retry is appropriate only when no successful transaction was mined. The contract independently rejects a duplicate vote.

## 8. Reorganisations

- Transfer cursors store block hashes and replay an overlap after mismatch.
- Vote indexing replays an overlap around the cursor.
- Snapshot block is confirmation-buffered and stores its hash.

Increase `CONFIRMATION_BLOCKS` for stronger finality at the cost of more delay around a near-present record date.

## 9. Neon maintenance

- Use pooled `DATABASE_URL` for API/worker traffic.
- Use direct `DATABASE_URL_DIRECT` for migrations.
- Place Render services near the Neon region.
- Rotate credentials after exposure.
- Use Neon branching/backups appropriate to your account.
- Periodically remove expired sessions/nonces and old operational data according to retention rules.

## 10. Source verification

Set in the Render worker:

```text
VERIFY_CONTRACTS=true
POLYGONSCAN_API_KEY=<secret>
```

Verification occurs after deployment. A verification failure does not invalidate a successfully deployed contract; the contract and transaction links remain available.

## 11. Communications

- `CORS_ORIGINS` must contain only approved dApp origins in production.
- Snap manifest allowed origins must match the production Vercel domain.
- Communications must be event-related and creator-signed.
- Never request seed phrases or arbitrary token transfers.
- Treat the Snap as an additional channel, not the only legally required communication method.

## 12. Incident response

### Relayer key suspected exposed

1. Stop the Render worker.
2. Replace the testnet wallet/key.
3. Update `RELAYER_PRIVATE_KEY` in the worker only.
4. Restart the worker after checking pending outbox transactions.
5. Existing contracts require no relayer update because they store no relayer address.

### Neon data suspected altered

1. Stop/block the API and worker.
2. Compare event rows with immutable contract getters.
3. Restore Neon from a known branch/backup.
4. Re-index `VoteCast` events from deployment blocks.
5. Do not serve ballot data when metadata/configuration integrity checks fail.

### RPC outage

1. Do not clear pending hashes/outbox rows.
2. Switch to a tested Amoy/archive provider.
3. Restart API/worker.
4. Let job and index cursors resume.
