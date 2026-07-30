# Complete execution and production deployment guide

This guide assumes a clean extraction of the repository and Polygon Amoy as the target chain.

## 1. Prerequisites

Install:

- Git
- Node.js 20.18.0
- npm 10 or a compatible npm version
- MetaMask Flask or a MetaMask build that supports development Snaps
- a Neon PostgreSQL project
- a Polygon Amoy HTTP RPC endpoint
- an archive-capable Polygon Amoy RPC endpoint
- a dedicated relayer wallet funded with a small amount of Amoy POL
- GitHub, Render, Vercel, npm, and PolygonScan accounts for production deployment

Check versions:

```bash
node --version
npm --version
git --version
```

The repository pins Node in `.nvmrc`:

```bash
nvm install 20.18.0
nvm use 20.18.0
```

## 2. Extract and install

```bash
unzip mini-galaxy-pv-v2-source.zip
cd mini-galaxy-pv-v2
npm install --include=dev --no-audit --no-fund
```

The first successful installation creates `package-lock.json`. Commit that lockfile before production deployment so Render, Vercel, CI, and local development resolve the same dependency graph.

On a company network, verify npm proxy configuration first:

```bash
npm config get proxy
npm config get https-proxy
npm config get registry
```

## 3. Configure Neon

Create a Neon project and obtain:

- a pooled application URL for normal API and worker traffic;
- a direct URL for schema migrations.

Copy the server environment template:

```bash
cp .env.example .env
```

Set:

```dotenv
DATABASE_URL=postgresql://YOUR_POOLED_NEON_CONNECTION
DATABASE_URL_DIRECT=postgresql://YOUR_DIRECT_NEON_CONNECTION
```

Do not commit `.env`.

Apply migrations:

```bash
npm run db:migrate
```

The following migration files are applied in order:

```text
db/migrations/001_initial.sql
db/migrations/002_relayer_transaction_outbox.sql
```

The migration runner uses an advisory lock to prevent simultaneous services from applying the same migration twice.

## 4. Configure Polygon Amoy

In `.env`:

```dotenv
CHAIN_ID=80002
RPC_HTTP_URL=https://YOUR_AMOY_RPC
RPC_ARCHIVE_URL=https://YOUR_ARCHIVE_CAPABLE_AMOY_RPC
BLOCK_EXPLORER_URL=https://amoy.polygonscan.com
CONFIRMATION_BLOCKS=12
REORG_OVERLAP_BLOCKS=16
```

The archive endpoint must support historical calls and logs at the chosen record-date block. Specifically, the worker needs historical:

- `eth_getCode`
- `eth_call`
- `eth_getLogs`
- block lookup by number

A recent-state-only public RPC may fail for older record dates.

## 5. Configure and fund the relayer

Create a dedicated Amoy-only wallet. Add to `.env`:

```dotenv
RELAYER_PRIVATE_KEY=0xYOUR_TESTNET_RELAYER_PRIVATE_KEY
```

Fund the address with Amoy POL. The relayer pays for:

- one `VoteEvent` deployment for each event;
- one final ballot transaction for each voter;
- any gas consumed by failed or reverted transactions.

Never expose this key to the React application or Vercel.

## 6. Configure the web application

```bash
cp apps/web/.env.local.example apps/web/.env.local
```

Set:

```dotenv
VITE_API_BASE_URL=http://localhost:3001
VITE_PUBLIC_RPC_URL=https://YOUR_PUBLIC_AMOY_RPC
VITE_BLOCK_EXPLORER_URL=https://amoy.polygonscan.com
VITE_SNAP_ID=local:http://localhost:8080
VITE_SNAP_VERSION=*
```

Every `VITE_*` value is public browser configuration. Do not place secrets in this file.

## 7. Validate, compile, and test

Run the source checks:

```bash
npm run check:syntax
npm run check:imports
npm run check:structure
npm run audit:architecture
```

Compile the one smart contract and export the runtime artifact:

```bash
npm run compile
```

Expected generated file:

```text
packages/contracts/generated/VoteEvent.json
```

Run tests:

```bash
npm run test:contracts
npm run test:shared
npm run test
```

Build the browser applications:

```bash
npm run build:web
npm run build:snap
```

The full validation command is:

```bash
npm run check
```

## 8. Run locally

Use four terminals from the repository root.

Terminal 1 - API:

```bash
npm run dev:api
```

Terminal 2 - snapshot/indexer/relayer worker:

```bash
npm run dev:indexer
```

Terminal 3 - MetaMask Snap development server:

```bash
npm run dev:snap
```

Terminal 4 - React/Vite frontend:

```bash
npm run dev:web
```

Open:

```text
http://localhost:5173
```

Check the API:

```bash
curl http://localhost:3001/health
```

A healthy response should show:

- `ok: true`;
- chain ID `80002`;
- a current Amoy block number;
- Neon database time;
- the latest worker heartbeat.

## 9. Standard ERC-20 compatibility requirements

V2 intentionally supports standard, historically queryable ERC-20 tokens only.

A token should:

- have deployed bytecode on Polygon Amoy;
- support `name`, `symbol`, `decimals`, `totalSupply`, and `balanceOf`;
- emit conventional indexed `Transfer(address,address,uint256)` events;
- have queryable historical balances at the record-date block;
- not use rebasing, reflection, hidden balance mutations, or nonstandard transfer accounting.

The worker reconstructs holder candidates from Transfer logs, reads historical balances, and checks reconstructed supply before marking the snapshot ready.

## 10. Create a first test event

Connect the creator wallet and authenticate by signing the API nonce.

Recommended first test:

```text
Record date: 5 to 15 minutes in the past
Voting start: 30 minutes in the future
Voting end: 24 hours later
Token-to-vote ratio X: 1
Authenticity claim: Community-created
Discovery: Public eligible holders
Snap delivery: Eligible holders
```

The event progresses through statuses similar to:

```text
SNAPSHOT_PENDING
SNAPSHOT_RUNNING
SNAPSHOT_READY
DEPLOYMENT_QUEUED
DEPLOYING
SCHEDULED or OPEN
CLOSED
```

Only one `VoteEvent` contract is deployed.

## 11. Voting flow to verify

Use a wallet that held the token at the record-date block.

Confirm:

1. The wallet sees all ongoing events for which it has a snapshot entry.
2. The selected event opens at `/events/:eventId/vote`.
3. Voting power is `floor(whole token balance / X)`.
4. The wallet signs one EIP-712 ballot.
5. The Render relayer pays the POL transaction fee.
6. A receipt replaces the ballot immediately.
7. The wallet stays connected and the route does not change.
8. The PolygonScan transaction link appears after broadcast.
9. The event contract link is displayed.
10. Reloading or reconnecting continues to show the receipt.
11. The ballot controls do not reappear after a confirmed vote.
12. A duplicate on-chain vote is rejected by `hasVoted`.

## 12. MetaMask Snap local flow

The Snap is dApp-triggered in V2.

The local dApp calls MetaMask to install:

```text
local:http://localhost:8080
```

The dApp then:

1. authenticates the connected wallet;
2. fetches eligible signed communications from the API;
3. invokes the Snap;
4. the Snap verifies the creator signature and allowed action URL;
5. the Snap deduplicates and stores the message;
6. MetaMask displays the notification;
7. the action returns the user to the correct event page.

The Snap does not perform voting and does not poll in the background in this release.

## 13. Upload to GitHub

Create a new empty GitHub repository, then run:

```bash
git init
git add .
git commit -m "Initial Mini Galaxy PV V2 implementation"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mini-galaxy-pv-v2.git
git push -u origin main
```

Before pushing:

```bash
git status
git ls-files | grep -E '(^|/)\.env$|\.key$|\.pem$'
```

The command should not reveal any real environment or key file.

## 14. Deploy API and worker to Render

The included `render.yaml` defines:

- `mini-galaxy-pv-v2-api` as a Render web service;
- `mini-galaxy-pv-v2-indexer` as a Render background worker.

Create a Render Blueprint from the GitHub repository.

API environment variables:

```text
DATABASE_URL
DATABASE_URL_DIRECT
RPC_HTTP_URL
CORS_ORIGINS
```

Worker environment variables:

```text
DATABASE_URL
DATABASE_URL_DIRECT
RPC_HTTP_URL
RPC_ARCHIVE_URL
RELAYER_PRIVATE_KEY
POLYGONSCAN_API_KEY
```

The relayer key must exist only on the worker.

After deploy, open:

```text
https://YOUR_RENDER_API/health
```

Confirm database, RPC, chain ID, and worker heartbeat.

## 15. Deploy the frontend to Vercel

Import the GitHub repository into Vercel. The root `vercel.json` provides the build and SPA rewrite configuration.

Set production environment variables:

```text
VITE_API_BASE_URL=https://YOUR_RENDER_API
VITE_PUBLIC_RPC_URL=https://YOUR_PUBLIC_AMOY_RPC
VITE_BLOCK_EXPLORER_URL=https://amoy.polygonscan.com
VITE_SNAP_ID=npm:@YOUR_NPM_SCOPE/pv-communications-snap
VITE_SNAP_VERSION=^0.1.0
```

After Vercel assigns the domain, update Render:

```text
CORS_ORIGINS=https://YOUR_VERCEL_DOMAIN
```

Redeploy the API after changing CORS.

## 16. Configure and publish the Snap

The source ZIP deliberately contains placeholder npm scope, repository, and dApp origin values.

Configure them:

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

Build and publish:

```bash
npm run build:snap
npm login
npm publish --workspace @pv/snap --access public
```

Set the published npm Snap ID in Vercel and redeploy the frontend.

Do not publish while the package still contains `REPLACE_ME` or `replace-with-your-npm-scope`.

## 17. PolygonScan verification

Set on the Render worker:

```text
POLYGONSCAN_API_KEY=YOUR_KEY
VERIFY_CONTRACTS=true
```

Contract verification is handled as a separate worker job. A successful deployment should be visible immediately even while source verification remains pending.

## 18. Production acceptance checklist

Before calling the environment ready, confirm:

- exactly one Solidity source exists;
- each event deployment creates exactly one contract;
- no compile or Hardhat child process runs inside an HTTP request;
- two creators can create events concurrently;
- the same token can have multiple independent events;
- one wallet can be eligible for several simultaneous events;
- record dates in the future are rejected;
- malformed or unsupported token snapshots fail clearly;
- false balances and invalid Merkle proofs fail on-chain;
- altered, replayed, or cross-contract ballots fail;
- a wallet cannot vote twice;
- the receipt appears before any page refresh;
- reconnecting never redisplays a completed ballot;
- indexed Neon tallies reconcile with on-chain tallies;
- worker restarts do not create duplicate deployments or votes;
- community-created events are clearly labelled;
- Snap messages are signed, deduplicated, origin-restricted, and deep-linked only to the approved dApp;
- no secret exists in the Vercel bundle or GitHub repository.

## 19. Mainnet warning

This delivery targets Polygon Amoy. Do not switch to Polygon mainnet until the contract and relayer flow have completed external security review, load testing, failure recovery testing, RPC-provider testing, and production key-management design.
