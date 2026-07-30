# API reference

Base path examples assume `http://localhost:3001`.

Authenticated routes use:

```http
Authorization: Bearer <session-token>
```

The browser obtains a token through the nonce/signature flow.

## Health

### `GET /health`

Returns API, chain, database and latest worker-heartbeat information.

## Authentication

### `POST /v1/auth/nonce`

```json
{ "walletAddress": "0x..." }
```

Returns a message and nonce for wallet signing.

### `POST /v1/auth/verify`

```json
{
  "walletAddress": "0x...",
  "signature": "0x..."
}
```

Returns the bearer session token.

### `GET /v1/auth/session`

Authenticated session details.

### `POST /v1/auth/logout`

Revokes the active bearer token.

## Token inspection

### `POST /v1/tokens/inspect`

```json
{ "tokenAddress": "0x..." }
```

Checks standard ERC-20 functions and optional conventional ownership metadata.

## Events

### `POST /v1/events`

Authenticated event creation. The request contains token, record date, voting window, ratio, proposal metadata, discovery/authenticity and Snap-delivery settings.

The API immediately stores the event and queues snapshot construction.

### `GET /v1/events?scope=ongoing|completed|all`

Lists public-discovery events.

### `GET /v1/events/created`

Lists events created by the authenticated wallet.

### `GET /v1/wallets/:wallet/events?scope=ongoing|completed|all`

Lists discoverable events for which the wallet has a positive snapshot voting power.

### `GET /v1/events/:eventId`

Returns event metadata, deployment state, job history, contract/explorer data and metadata-integrity check.

### `GET /v1/events/:eventId/eligibility/:wallet`

Returns snapshot balance, voting power, Merkle proof, vote receipt and event status.

### `POST /v1/events/:eventId/retry-snapshot`

Creator-only retry after a failed snapshot.

### `POST /v1/events/:eventId/retry-deployment`

Creator-only retry after a failed deployment where the immutable snapshot is still valid.

## Ballots and votes

### `POST /v1/events/:eventId/ballot`

Authenticated wallet submits selected option indexes:

```json
{ "choices": [0, 1, 2] }
```

Returns EIP-712 typed data, choices bytes, eligibility proof and display information.

### `POST /v1/events/:eventId/votes`

```json
{
  "choices": [0, 1, 2],
  "signature": "0x..."
}
```

Queues a gas-sponsored vote and returns a receipt projection immediately.

### `POST /v1/events/:eventId/votes/retry`

Requeues a vote whose previous job failed without a successful on-chain vote.

### `GET /v1/events/:eventId/votes/:wallet`

Returns the wallet’s vote receipt/status for the event.

### `GET /v1/events/:eventId/results`

Returns proposal labels and on-chain tally values. The frontend should present final results after the event closes.

## Creator communications

### `GET /v1/events/:eventId/communications`

Creator-only list of communications for an event.

### `POST /v1/events/:eventId/communications/payload`

Creator-only. Produces a canonical message payload for wallet signing.

### `POST /v1/events/:eventId/communications`

Creator-only. Publishes the signed communication after server verification.

## Snap subscriptions and inbox

### `GET /v1/snap/subscriptions`

Lists the authenticated wallet’s token subscriptions.

### `POST /v1/snap/subscriptions`

Creates/updates a subscription preference.

### `GET /v1/communications/inbox`

Returns unread/eligible dApp-triggered messages for the authenticated wallet.

### `POST /v1/communications/delivered`

```json
{ "messageIds": ["uuid", "uuid"] }
```

Acknowledges messages accepted by the Snap/dApp delivery flow.

## Error shape

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "...",
    "details": {}
  }
}
```
