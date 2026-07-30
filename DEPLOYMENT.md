# Complete execution and deployment guide

This guide covers local execution, Neon, GitHub, Render, Vercel, MetaMask Snap publication, and an Amoy smoke test.

## A. Prerequisites

Install:

- Git.
- Node.js `20.18.0` (recommended; compatible Node 20/22 may work).
- npm.
- MetaMask Flask or a compatible MetaMask build for local Snap testing.
- Access to Neon PostgreSQL.
- Polygon Amoy standard RPC and archive-capable RPC.
- A dedicated Amoy relayer wallet funded with test POL.
- An npm account for publishing the Snap.
- GitHub, Render and Vercel accounts.

Check versions:

```bash
node --version
npm --version
git --version
```

Use Node Version Manager where available:

```bash
nvm install 20.18.0
nvm use 20.18.0
```

## B. Extract and inspect the project

```bash
unzip mini-galaxy-pv-v2-source.zip
cd mini-galaxy-pv-v2
```

Confirm the one-contract invariant:

```bash
find packages/contracts/contracts -name '*.sol' -print
```

Expected:

```text
packages/contracts/contracts/VoteEvent.sol
```

## C. Configure corporate npm networking

On the Broadridge network, use the approved proxy configuration already provided by IT/security. Example:

```bash
npm config set proxy http://YOUR_APPROVED_PROXY:PORT
npm config set https-proxy http://YOUR_APPROVED_PROXY:PORT
npm config set registry https://registry.npmjs.org/
npm ping
```

Do not commit `.npmrc` when it contains internal proxy or credentials. `.npmrc` is ignored by this repository.

## D. Install dependencies

```bash
npm install --include=dev --no-audit --no-fund
```

A successful first installation generates `package-lock.json`. Keep and commit it:

```bash
git add package-lock.json
git commit -m "Add reproducible dependency lockfile"
```

After the lockfile is committed, CI/deployment can use `npm ci` for exact reproducibility.

## E. Create Neon PostgreSQL

1. Create a Neon project for V2.
2. Create/identify a production branch/database.
3. Copy the pooled connection string.
4. Copy the direct non-pooler connection string.
5. Prefer a Neon region close to Render Singapore, or change Render region to match Neon.

The pooled URL is used by API/worker runtime traffic:

```text
DATABASE_URL=postgresql://...-pooler.../DB?sslmode=require
```

The direct URL is used for migrations:

```text
DATABASE_URL_DIRECT=postgresql://.../DB?sslmode=require
```

## F. Configure Polygon Amoy RPC

You need:

```text
RPC_HTTP_URL=<normal Amoy JSON-RPC>
RPC_ARCHIVE_URL=<Amoy RPC supporting historical state/logs>
```

The archive endpoint must support:

- `eth_getLogs` across token history;
- historical `eth_call` for `balanceOf` and `totalSupply`;
- historical `eth_getCode`.

Use chain ID:

```text
80002
```

Explorer:

```text
https://amoy.polygonscan.com
```

## G. Create/fund the relayer wallet

Create a dedicated testnet wallet. Fund it with Amoy POL.

The wallet pays for:

- one contract deployment per event;
- every gasless voter transaction.

Never use a personal mainnet wallet or expose the key to the browser.

## H. Configure local server environment

Copy:

```bash
cp .env.example .env
```

Fill `.env`:

```dotenv
NODE_ENV=development
CHAIN_ID=80002
RPC_HTTP_URL=https://YOUR_AMOY_RPC
RPC_ARCHIVE_URL=https://YOUR_ARCHIVE_AMOY_RPC
BLOCK_EXPLORER_URL=https://amoy.polygonscan.com
CONFIRMATION_BLOCKS=12
REORG_OVERLAP_BLOCKS=16

DATABASE_URL=postgresql://YOUR_POOLED_NEON_URL
DATABASE_URL_DIRECT=postgresql://YOUR_DIRECT_NEON_URL

RELAYER_PRIVATE_KEY=0xYOUR_DEDICATED_TESTNET_PRIVATE_KEY

PORT=3001
CORS_ORIGINS=http://localhost:5173
SESSION_TTL_HOURS=24
AUTH_NONCE_TTL_MINUTES=10
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=240
MAX_DEPLOYMENTS_PER_WALLET_PER_DAY=5

WORKER_ID=local-worker-1
WORKER_POLL_INTERVAL_MS=1500
TRANSFER_LOG_CHUNK_SIZE=2500
VOTE_LOG_CHUNK_SIZE=2500
BALANCE_CALL_CONCURRENCY=16
MAX_SNAPSHOT_CANDIDATES=100000
TOKEN_SCAN_START_BLOCK=0
JOB_CONCURRENCY=3
JOB_LOCK_MINUTES=10
TRANSACTION_WAIT_TIMEOUT_MS=180000

POLYGONSCAN_API_KEY=
VERIFY_CONTRACTS=false
```

## I. Configure local frontend

```bash
cp apps/web/.env.local.example apps/web/.env.local
```

Use:

```dotenv
VITE_API_BASE_URL=http://localhost:3001
VITE_PUBLIC_RPC_URL=https://YOUR_PUBLIC_AMOY_RPC
VITE_BLOCK_EXPLORER_URL=https://amoy.polygonscan.com
VITE_SNAP_ID=local:http://localhost:8080
VITE_SNAP_VERSION=*
```

Never put database URLs, relayer keys, archive-RPC secrets or explorer API keys in `VITE_*` variables. They are public browser values.

## J. Run static checks

```bash
npm run check:syntax
npm run check:imports
npm run check:structure
npm run audit:architecture
```

All must pass.

## K. Compile and test

```bash
npm run compile
```

This creates:

```text
packages/contracts/generated/VoteEvent.json
```

Then:

```bash
npm run test
npm run build:web
npm run build:snap
```

Do not deploy when any command fails.

## L. Run Neon migrations

```bash
npm run db:migrate
```

The migrations create all event, token, snapshot, job, vote, communication, session and crash-safe transaction-outbox tables.

## M. Run locally

Use four terminals.

Terminal 1:

```bash
npm run dev:api
```

Terminal 2:

```bash
npm run dev:indexer
```

Terminal 3:

```bash
npm run dev:snap
```

Terminal 4:

```bash
npm run dev:web
```

Open:

```text
http://localhost:5173
```

Check API health:

```bash
curl http://localhost:3001/health
```

Expected information:

- `ok: true`;
- chain ID `80002`;
- current block number;
- Neon database time;
- recent worker heartbeat.

## N. Test a standard ERC-20

Use a standard token deployed on Amoy that:

- implements `name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`;
- emits conventional indexed `Transfer` events;
- has historical state available through the archive RPC;
- is not rebasing/reflection based;
- has at least one holder with enough complete tokens under the chosen ratio.

The repository deliberately does not add a test token contract because the V2 invariant is exactly one application Solidity source.

## O. Create the first event

Suggested initial values:

```text
Record date: 5-15 minutes in the past
Voting start: at least 30 minutes in the future
Voting end: 1 day later
Token-to-vote ratio: 1
Authenticity: Community
Discovery: Public eligible
Snap delivery: Eligible
```

Add proposals and 2-4 options per proposal.

Watch the creator page/job status:

```text
SNAPSHOT_PENDING
SNAPSHOT_RUNNING
DEPLOYMENT_QUEUED
DEPLOYING
SCHEDULED / OPEN
```

Snapshot time is separate from deployment time. The actual event deployment is one transaction, but token history processing can take longer for old/active tokens.

## P. Verify investor voting

Connect an eligible snapshot wallet and confirm:

1. The event appears in Ongoing Events.
2. Clicking it opens the event-specific voting dashboard.
3. Voting power equals `floor(whole tokens / X)`.
4. Wallet signs one EIP-712 ballot.
5. No POL is requested from the investor.
6. Ballot disappears immediately after submission.
7. Queued receipt appears without disconnect/navigation.
8. Transaction link appears after relayer broadcast.
9. Contract link is shown.
10. Reload/reconnect keeps the receipt and does not show ballot options.
11. A duplicate vote is rejected by `hasVoted`.
12. Event-specific results appear after close.

## Q. Initialize Git/GitHub

Before pushing, verify no secrets:

```bash
git status
git ls-files | grep -E '(^|/)\.env$|private|secret|\.key$|\.pem$' || true
```

Create a new GitHub repository and push:

```bash
git init
git add .
git commit -m "Initial Mini Galaxy PV V2"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mini-galaxy-pv-v2.git
git push -u origin main
```

GitHub Actions runs source checks, compile, tests and web/Snap builds.

## R. Configure the Snap package placeholders

Before publishing, set the GitHub URL, npm scope, and final dApp origin:

```bash
npm run configure:project -- \
  --repository https://github.com/YOUR_USERNAME/mini-galaxy-pv-v2.git \
  --snap-package @YOUR_NPM_SCOPE/pv-communications-snap \
  --origin https://YOUR_VERCEL_DOMAIN
```

Review:

```bash
git diff apps/snap/package.json apps/snap/snap.manifest.json
```

Commit the configuration.

## S. Deploy Render from `render.yaml`

Create a Render Blueprint from the GitHub repository. It creates:

- `mini-galaxy-pv-v2-api` as a web service;
- `mini-galaxy-pv-v2-indexer` as a background worker.

### API secrets

```text
DATABASE_URL
DATABASE_URL_DIRECT
RPC_HTTP_URL
CORS_ORIGINS
```

### Worker secrets

```text
DATABASE_URL
DATABASE_URL_DIRECT
RPC_HTTP_URL
RPC_ARCHIVE_URL
RELAYER_PRIVATE_KEY
POLYGONSCAN_API_KEY
```

Only the worker receives `RELAYER_PRIVATE_KEY`.

The Blueprint uses:

- Node `20.18.0`;
- `npm install`;
- static checks;
- database migration in pre-deploy;
- contract compilation in worker build;
- Singapore region by default.

After deployment, open:

```text
https://YOUR_RENDER_API/health
```

Confirm database, chain and worker heartbeat.

## T. Deploy Vercel

Import the same GitHub repository into Vercel.

The included `vercel.json` sets:

```text
Install: npm install --include=dev --no-audit --no-fund
Build: npm run build:web
Output: apps/web/dist
SPA rewrite: enabled
```

Set Vercel production environment variables:

```text
VITE_API_BASE_URL=https://YOUR_RENDER_API
VITE_PUBLIC_RPC_URL=https://YOUR_PUBLIC_AMOY_RPC
VITE_BLOCK_EXPLORER_URL=https://amoy.polygonscan.com
VITE_SNAP_ID=npm:@YOUR_NPM_SCOPE/pv-communications-snap
VITE_SNAP_VERSION=^0.1.0
```

Deploy.

Then update Render API:

```text
CORS_ORIGINS=https://YOUR_VERCEL_DOMAIN
```

Redeploy/restart the API after updating CORS.

## U. Publish the MetaMask Snap

For local testing, keep:

```text
VITE_SNAP_ID=local:http://localhost:8080
```

For npm publication:

```bash
npm login
npm run build:snap
npm publish --workspace @YOUR_NPM_SCOPE/pv-communications-snap --access public
```

Depending on npm workspace naming, publishing directly from the Snap folder is also valid:

```bash
cd apps/snap
npm publish --access public
```

Ensure:

- package name matches `snap.manifest.json`;
- package version matches manifest version;
- manifest source shasum was updated by the Snap build/manifest command;
- allowed origin and initial connection use the exact Vercel production origin;
- placeholder repository/scope values are gone;
- no localhost origin remains in production publication unless intentionally needed for a development-only package.

After publishing, update Vercel `VITE_SNAP_ID`/version and redeploy.

## V. Optional PolygonScan source verification

In Render worker set:

```text
VERIFY_CONTRACTS=true
POLYGONSCAN_API_KEY=<your key>
```

The transaction and contract links are available as soon as deployment is mined. Source verification is separate and may complete later.

## W. Production smoke test

Run these checks on the deployed stack:

1. Vercel page loads with no mixed-content/CORS error.
2. Wallet connects and signed login succeeds.
3. Token inspection works.
4. Event creation queues snapshot.
5. Worker heartbeat updates.
6. Snapshot completes for test token.
7. Exactly one contract is deployed.
8. Contract address and PolygonScan links display.
9. Two different events can progress at the same time.
10. Eligible wallet sees both events.
11. Vote is gasless to investor.
12. Ballot is replaced by receipt immediately.
13. Reconnect/reload keeps the receipt.
14. Results match on-chain tallies.
15. Snap installs through the dApp.
16. Creator-signed communication appears once and deep-links correctly.

## X. Recommended move from `npm install` to `npm ci`

After `package-lock.json` exists and is committed, change:

- GitHub Actions install step;
- `render.yaml` build commands;
- `vercel.json` install command;

to:

```text
npm ci --include=dev --no-audit --no-fund
```

This gives repeatable dependency installation.

## Y. Troubleshooting

### `EAI_AGAIN`, `ETIMEDOUT`, or registry failures

Check corporate proxy and DNS:

```bash
npm config get proxy
npm config get https-proxy
npm config get registry
npm ping
```

### API says worker missing/stale

- Start/deploy the indexer worker.
- Check `DATABASE_URL`, RPC URLs and `RELAYER_PRIVATE_KEY`.
- Inspect Render worker logs.

### Snapshot fails

- Confirm archive provider supports historical state.
- Lower `TRANSFER_LOG_CHUNK_SIZE`.
- Lower `BALANCE_CALL_CONCURRENCY` if throttled.
- Check token is standard and reconstructed supply matches.

### Deployment does not occur

- Confirm `npm run compile` generated `packages/contracts/generated/VoteEvent.json` in the worker build.
- Check relayer POL balance.
- Inspect deployment job and relayer outbox rows.
- Check RPC pending nonce.

### Vercel CORS error

Set Render API `CORS_ORIGINS` to the exact scheme/host, without a trailing slash.

### Snap installation fails

- Use MetaMask Flask/compatible release.
- Confirm local Snap server on `http://localhost:8080`.
- Confirm manifest allowed origin equals the dApp origin.
- For npm Snap, confirm package/manifest versions and shasum.

## Z. Before any mainnet work

Do not change chain ID and deploy to mainnet without:

- independent smart-contract audit;
- threat model and security review;
- legal/compliance review;
- relayer spending controls and treasury design;
- archive/indexer load testing;
- database backup/recovery procedure;
- monitoring and incident response;
- Snap distribution/review requirements;
- privacy/communications policy;
- formal production acceptance testing.
