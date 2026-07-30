# Mini Galaxy Proxy Voting V2

Mini Galaxy PV V2 is a separate rewrite of the existing proxy-voting proof of concept for **Polygon Amoy**.

The V2 design removes the V1 persona workflow and multi-contract deployment sequence. Every voting event deploys **exactly one `VoteEvent` contract**. Neon PostgreSQL is the event catalogue and indexed read layer, a Render background worker builds record-date snapshots and sponsors contract/vote transactions, the React/Vite application is hosted on Vercel, and a dApp-triggered MetaMask Snap delivers creator-signed communications.

> This repository is a testnet proof of concept. It has not been independently audited and must not be treated as production financial infrastructure or as a replacement for legally required shareholder communications.

## Product decisions implemented

- Polygon Amoy only (`chainId 80002`).
- Relayer wallet on Render pays the POL fee for event deployment and each final ballot.
- Exactly one deployable application contract: `packages/contracts/contracts/VoteEvent.sol`.
- Record date must be present or past. Future dates are rejected.
- Standard, Transfer-indexable ERC-20 tokens only.
- Eligibility is derived from a record-date off-chain snapshot committed by a Merkle root.
- Token-to-vote ratio is a natural number `X`; voting power is `floor(raw token balance / voteUnit)`, where `voteUnit = X * 10^decimals`.
- One final vote per eligible wallet. No update, recall, delegation, pause, or role administration.
- Multiple events can be created, snapshotted, deployed, indexed, and voted on concurrently.
- Creator chooses authenticity claim, discovery mode, and Snap delivery mode.
- Proposal text and options are stored in Neon and committed by an immutable metadata hash in the contract.
- Proposal tallies remain in the `VoteEvent` contract.
- After voting, the ballot is replaced immediately by a persistent receipt; reconnecting does not redisplay the ballot.
- Snap delivery is triggered by the dApp in this release. There is no background polling permission.

## Architecture

```text
Creator / Investor wallet
          |
          v
Vercel React/Vite dApp
  |                 |
  | HTTPS           | wallet_requestSnaps / wallet_snap
  v                 v
Render API       MetaMask Snap
  |
  +--------------------------+
  |                          |
  v                          v
Neon PostgreSQL       Polygon Amoy RPC
  ^                          ^
  |                          |
  +----- Render Worker ------+
        - snapshot builder
        - deployment relayer
        - vote relayer
        - VoteCast indexer
        - source verification
```

### One-contract invariant

The only Solidity source under the application contract directory is:

```text
packages/contracts/contracts/VoteEvent.sol
```

There is no factory, deployment registry, company token, access-list contract, transfer-agent contract, proxy-solicitor contract, or persona contract. OpenZeppelin libraries are compiled into `VoteEvent` bytecode and do not deploy additional contracts.

## Event lifecycle

```text
Creator submits event
    -> SNAPSHOT_PENDING
    -> SNAPSHOT_RUNNING
    -> DEPLOYMENT_QUEUED
    -> DEPLOYING
    -> SCHEDULED or OPEN
    -> CLOSED
```

1. Creator connects MetaMask and signs a zero-gas login message.
2. Creator enters a standard ERC-20 address, event title, record date, voting window, natural-number token-to-vote ratio, proposals, options, recommendation, authenticity claim, discovery mode, and Snap delivery mode.
3. API stores the event in Neon and queues `BUILD_SNAPSHOT`.
4. Worker resolves the latest confirmation-buffered Amoy block at or before the record date.
5. Worker discovers holder candidates from standard ERC-20 `Transfer` events and reads historical `balanceOf` values.
6. Worker checks that reconstructed positive balances equal historical `totalSupply`. Tokens that cannot satisfy this standard reconstruction are rejected.
7. Worker calculates voting power, builds a Merkle tree, stores proofs in Neon, and queues `DEPLOY_EVENT`.
8. Render relayer signs and broadcasts one `VoteEvent` deployment transaction.
9. Eligible wallets see all discoverable ongoing events in their portal.
10. Investor signs one EIP-712 ballot. Render submits it and pays gas.
11. Contract verifies the snapshot proof and signature, rejects duplicate voting, and updates proposal tallies.
12. Worker indexes `VoteCast` logs and updates the Neon receipt projection.
13. Results page reads the event-specific on-chain tallies after the voting end time.

## On-chain versus off-chain data

| Polygon Amoy `VoteEvent` | Neon / Render |
|---|---|
| Creator address | Searchable event catalogue |
| ERC-20 token address | Proposal text and option labels |
| Snapshot block | Transfer-index cursors |
| Snapshot Merkle root | Holder candidates and historical balances |
| Voting start/end | Merkle proofs and voting-power lookup |
| Raw token units required for one vote | Job queue and worker heartbeat |
| Metadata hash | Indexed vote receipts |
| Packed proposal option counts | Creator communications/subscriptions |
| `hasVoted` | Source-verification status |
| Proposal tallies | UI-friendly result projection |
| `VoteCast` log | Delivery/read state |

Neon is a fast indexed read layer. It does not replace on-chain vote enforcement or final tallies.

## Repository structure

```text
apps/
  api/       Express API, wallet authentication, event/vote/Snap endpoints
  indexer/   Neon-backed worker, snapshot builder, deployer, relayer, indexer
  web/       React/Vite dApp using the existing visual language
  snap/      Dapp-triggered MetaMask Snap
packages/
  contracts/ VoteEvent, Hardhat config, tests, artifact exporter
  shared/    ABI, metadata hashing, Merkle and EIP-712 helpers
db/
  migrations/ PostgreSQL/Neon schema and relayer transaction outbox
scripts/
  static checks and Snap configuration helpers
docs/
  architecture, API, deployment, operations and validation guides
render.yaml  Render API + background-worker Blueprint
vercel.json  Vercel Vite deployment configuration
```

## Quick local start

### Prerequisites

- Node.js `20.18.0` recommended.
- npm.
- Neon PostgreSQL or a compatible local PostgreSQL instance.
- Polygon Amoy HTTP RPC.
- Archive-capable Amoy RPC for historical logs/state.
- Dedicated testnet relayer wallet funded with Amoy POL.
- MetaMask Flask or another MetaMask version supporting the required Snap APIs.

### 1. Install dependencies

```bash
npm install --include=dev --no-audit --no-fund
```

The first successful install creates `package-lock.json`. Commit it before team/production deployment.

On the Broadridge corporate network, configure the approved proxy first, without committing proxy credentials:

```bash
npm config set proxy http://YOUR_APPROVED_PROXY:PORT
npm config set https-proxy http://YOUR_APPROVED_PROXY:PORT
npm ping
```

### 2. Configure API and worker

```bash
cp .env.example .env
```

Set at minimum:

```text
DATABASE_URL
DATABASE_URL_DIRECT
RPC_HTTP_URL
RPC_ARCHIVE_URL
RELAYER_PRIVATE_KEY
CORS_ORIGINS=http://localhost:5173
```

### 3. Configure web app

```bash
cp apps/web/.env.local.example apps/web/.env.local
```

### 4. Migrate, compile, test, and build

```bash
npm run db:migrate
npm run compile
npm run test
npm run build:web
npm run build:snap
```

### 5. Run locally

Use four terminals:

```bash
npm run dev:api
```

```bash
npm run dev:indexer
```

```bash
npm run dev:snap
```

```bash
npm run dev:web
```

Open `http://localhost:5173`.

## Main commands

```bash
npm run check:syntax         # Parse JS/JSX/TS/TSX source
npm run check:imports        # Resolve local relative imports
npm run check:structure      # Validate one-contract and secret boundaries
npm run audit:architecture   # Audit V2 invariants and legacy-code absence
npm run compile              # Hardhat compile + generated VoteEvent artifact
npm run test                 # Contract and shared-package tests
npm run build:web            # Production Vite build
npm run build:snap           # Production Snap build/manifest
npm run db:migrate           # Ordered Neon/PostgreSQL migrations
npm run dev                  # API + worker + web; Snap stays separate
```

## Creator options

### Authenticity claim

- `COMMUNITY`: no issuer-authority claim.
- `ISSUER_AUTHORIZED`: creator claims authorization. When the token exposes a conventional `owner()` and the creator matches it, the UI can label the event token-owner verified. ERC-20 itself does not standardize legal issuer identity.

### Discovery mode

- `PUBLIC_ELIGIBLE`: listed publicly and shown to eligible wallets.
- `SUBSCRIBERS_ONLY`: shown only to eligible subscribed wallets.
- `DIRECT_LINK`: omitted from discovery lists and opened by event URL.

### Snap delivery mode

- `ELIGIBLE`: creator communications may target eligible holders.
- `SUBSCRIBERS_ONLY`: delivery requires an active token subscription.
- `DISABLED`: communications are disabled for the event.

## Important limitations

- A one-contract deployment should be a single Amoy transaction, but building a snapshot for an old/high-activity token can still take time because historical logs and balances must be processed.
- The archive RPC must support historical `eth_call`, `eth_getCode`, and `eth_getLogs`.
- Rebasing, reflection, fee-on-transfer bookkeeping that cannot be reconstructed, missing Transfer history, and other nonstandard token behavior may be rejected.
- On-chain tallies are publicly observable before the UI displays final results.
- A public sponsored deployment endpoint is an economic-abuse surface. The API includes authentication, limits, idempotent jobs, and transaction outbox handling, but wider deployment requires stronger spending controls and monitoring.
- The Snap is an additional communication channel, not the sole legally required channel.

## Full instructions

Read:

- `docs/DEPLOYMENT.md` — local, Neon, GitHub, Render, Vercel and Snap deployment.
- `docs/ARCHITECTURE.md` — system and transaction flows.
- `docs/API.md` — HTTP endpoints.
- `docs/OPERATIONS.md` — relayer/indexer operations and recovery.
- `docs/VALIDATION.md` — checks performed and remaining validation.
