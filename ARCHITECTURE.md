# Architecture

## 1. Design goal

V2 replaces the V1 multi-contract, role-driven, single-current-event architecture with one immutable contract per event and a database-backed discovery/indexing layer.

The contract remains authoritative for eligibility proof verification, one-vote enforcement, voting periods, and proposal tallies. Neon stores searchable content and indexed projections.

## 2. Components

### React/Vite web application

- Wallet connection and signed session authentication.
- Public event browsing.
- Wallet-specific eligible-event list.
- Event creator interface and proposal preparation.
- Ballot signing and immediate receipt display.
- Creator communications interface.
- Snap installation, invocation, subscriptions, and inbox.

### Express API

- Nonce/session authentication.
- ERC-20 inspection.
- Event creation and lookup.
- Creator ownership checks.
- Eligibility/Merkle proof reads.
- EIP-712 ballot preparation.
- Vote job submission and receipt lookup.
- Results lookup.
- Communication signing payloads, publishing, delivery and subscription APIs.

### Render worker

- Claims Neon jobs using PostgreSQL row locking/advisory locks.
- Resolves record-date blocks.
- Scans standard ERC-20 Transfer logs.
- Reads historical balances from archive RPC.
- Builds Merkle snapshots.
- Deploys exactly one `VoteEvent` per event.
- Relays signed final ballots.
- Indexes `VoteCast` logs.
- Reconciles transaction receipts and optional source verification.
- Updates worker heartbeat.

### Neon PostgreSQL

- Event catalogue and metadata.
- Token compatibility records and scan cursors.
- Holder candidates and snapshot entries.
- Merkle proofs.
- Job queue.
- Crash-safe raw signed transaction outbox.
- Vote transaction projection.
- Communications, subscriptions and delivery records.

### `VoteEvent`

The contract stores only event-critical immutable values plus one-vote state and tallies:

```text
creator
tokenAddress
snapshotBlock
snapshotRoot
votingStart
votingEnd
voteUnit
metadataHash
proposalConfig
hasVoted
tallies
```

No relayer address is stored. Anyone can submit a correctly signed ballot, allowing the Render wallet to sponsor gas without becoming a privileged contract role.

## 3. Snapshot flow

```text
Create event in API
 -> BUILD_SNAPSHOT job
 -> resolve safe record block
 -> find token deployment block
 -> scan Transfer logs to record block
 -> read historical balanceOf for candidates
 -> compare reconstructed supply to totalSupply
 -> calculate floor(balance / voteUnit)
 -> drop zero-voting-power wallets
 -> build sorted-pair Merkle tree
 -> store entries/proofs/root
 -> queue DEPLOY_EVENT
```

The Merkle leaf is derived from wallet and raw snapshot balance. A voter cannot claim a larger balance because the proof fails.

## 4. Deployment flow

```text
DEPLOY_EVENT job
 -> load generated VoteEvent artifact
 -> validate event/snapshot/configuration
 -> construct deployment transaction
 -> sign with relayer
 -> persist raw signed transaction + expected hash
 -> broadcast exact raw transaction
 -> wait/reconcile receipt
 -> validate deployed address and immutable getters
 -> store contract address/deployment block
 -> queue optional source verification
```

Persisting the signed raw transaction before broadcast prevents duplicate deployments after worker restarts.

## 5. Voting flow

```text
Wallet opens event
 -> API returns eligibility/proof/voting power
 -> dApp requests typed ballot
 -> wallet signs EIP-712 Ballot(voter, choicesHash)
 -> API validates request and queues RELAY_VOTE
 -> UI immediately replaces ballot with queued receipt
 -> worker signs/persists/broadcasts transaction
 -> VoteEvent verifies window, hasVoted, proof, signature and options
 -> VoteEvent updates tallies and emits VoteCast
 -> worker/API updates Neon receipt
```

The contract domain contains the verifying contract address and chain ID, so a ballot signature cannot be reused on another event contract.

## 6. Multiple events

There is no global latest contract or global deployment lock. Every row is keyed by event UUID and deployed contract address.

Jobs for different events run concurrently. Transfer-cursor mutation for the same token is briefly protected by a token-specific advisory lock, while other token snapshots continue independently.

## 7. Receipt/reconnection behavior

The frontend obtains vote state from Neon and checks `hasVoted` on-chain as a fallback. When either source confirms/indicates a submitted vote, the ballot component is not rendered.

`accountsChanged` invalidates wallet-specific queries but does not navigate away or treat an account event as a new connect request.

## 8. Communications/Snap flow

```text
Creator composes message in dApp
 -> API creates canonical payload
 -> creator signs payload
 -> API validates creator and stores message
 -> eligible/subscribed wallet opens dApp
 -> dApp fetches unread messages
 -> dApp invokes installed Snap
 -> Snap independently verifies signature/origin/expiry/action URL
 -> Snap deduplicates and stores message
 -> Snap shows MetaMask notification and inbox entry
 -> action deep-links back to event
```

The Snap is dApp-triggered in V2. It does not request background network access.

## 9. Security boundaries

- Relayer private key: Render worker only.
- Neon credentials: Render API/worker only.
- Browser variables: public values only.
- Contract: final eligibility/tally enforcement.
- Database: searchable projection, never allowed to override contract truth.
- Snap: display/verification channel, not a transaction authority.
