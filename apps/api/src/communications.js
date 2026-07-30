import { randomUUID } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { buildCommunicationSigningMessage } from '@pv/shared';
import { config } from './config.js';
import { query } from './db.js';
import { HttpError, normalizeAddress } from './errors.js';
import { assertEventCreator } from './events.js';

function assertTrustedActionUrl(actionUrl) {
  let origin;
  try {
    origin = new URL(actionUrl).origin.replace(/\/$/, '');
  } catch {
    throw new HttpError(400, 'Communication action URL is invalid.', 'INVALID_ACTION_URL');
  }
  if (!config.webOrigins.includes(origin)) {
    throw new HttpError(
      400,
      'Communication action links must use an approved V2 dApp origin.',
      'UNTRUSTED_ACTION_URL',
    );
  }
}

function normalizeCommunication(event, input) {
  return {
    chainId: Number(event.chain_id),
    eventId: event.id,
    eventTitle: event.title,
    tokenSymbol: event.token_symbol,
    contractAddress: event.contract_address,
    creatorAddress: event.creator_address,
    authenticityStatus: event.authenticity_status,
    messageId: input.messageId ?? randomUUID(),
    title: input.title,
    body: input.body,
    category: input.category,
    audience: input.audience,
    publishedAt: new Date(input.publishedAt).toISOString(),
    expiresAt: new Date(input.expiresAt).toISOString(),
    actionUrl: input.actionUrl,
  };
}

function assertCommunicationAllowed(event, input) {
  if (!event.contract_address || event.deployment_block === null) {
    throw new HttpError(409, 'Communications can be published after deployment.', 'EVENT_NOT_DEPLOYED');
  }
  if (event.snap_delivery_mode === 'DISABLED') {
    throw new HttpError(409, 'Snap delivery is disabled for this event.', 'SNAP_DISABLED');
  }
  if (event.snap_delivery_mode === 'SUBSCRIBERS_ONLY' && input.audience !== 'SUBSCRIBERS') {
    throw new HttpError(400, 'This event only permits subscriber delivery.', 'AUDIENCE_NOT_ALLOWED');
  }
  assertTrustedActionUrl(input.actionUrl);
}

export async function prepareCommunication(eventId, walletAddress, input) {
  const event = await assertEventCreator(eventId, walletAddress);
  assertCommunicationAllowed(event, input);
  const message = normalizeCommunication(event, input);
  return { message, signingMessage: buildCommunicationSigningMessage(message) };
}

export async function publishCommunication(eventId, walletAddress, input) {
  const event = await assertEventCreator(eventId, walletAddress);
  assertCommunicationAllowed(event, input.message);
  const message = normalizeCommunication(event, input.message);

  let recovered;
  try {
    recovered = normalizeAddress(
      verifyMessage(buildCommunicationSigningMessage(message), input.signature),
    );
  } catch {
    throw new HttpError(401, 'Communication signature is invalid.', 'INVALID_COMMUNICATION_SIGNATURE');
  }
  if (recovered !== event.creator_address) {
    throw new HttpError(401, 'Communication signature does not match the event creator.', 'CREATOR_SIGNATURE_REQUIRED');
  }

  const signingMessage = buildCommunicationSigningMessage(message);
  const result = await query(
    `INSERT INTO communications (
       message_id, event_id, creator_address, category, audience,
       title, body, action_url, published_at, expires_at, signing_message, creator_signature
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      message.messageId,
      eventId,
      event.creator_address,
      message.category,
      message.audience,
      message.title,
      message.body,
      message.actionUrl,
      message.publishedAt,
      message.expiresAt,
      signingMessage,
      input.signature,
    ],
  );
  return { ...message, signature: result.rows[0].creator_signature };
}

export async function listEventCommunications(eventId, walletAddress) {
  await assertEventCreator(eventId, walletAddress);
  const result = await query(
    `SELECT * FROM communications WHERE event_id = $1 ORDER BY published_at DESC`,
    [eventId],
  );
  return result.rows;
}

export async function upsertSubscription(walletAddress, input) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const token = normalizeAddress(input.tokenAddress, 'tokenAddress');
  const knownToken = await query(
    `SELECT name, symbol, standard_status FROM tokens
     WHERE chain_id = $1 AND token_address = $2`,
    [config.chainId, token],
  );
  if (!knownToken.rowCount) {
    throw new HttpError(
      400,
      'Inspect this ERC-20 token in the dApp before subscribing.',
      'TOKEN_NOT_INSPECTED',
    );
  }
  if (knownToken.rows[0].standard_status === 'UNSUPPORTED') {
    throw new HttpError(400, 'This token is not compatible with V2 snapshots.', 'UNSUPPORTED_TOKEN');
  }

  const status = input.enabled ? 'ACTIVE' : 'REVOKED';
  const result = await query(
    `INSERT INTO snap_subscriptions (
       wallet_address, chain_id, token_address, categories, status
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (wallet_address, chain_id, token_address) DO UPDATE SET
       categories = EXCLUDED.categories,
       status = EXCLUDED.status
     RETURNING *`,
    [wallet, config.chainId, token, input.categories, status],
  );
  return {
    ...result.rows[0],
    token_name: knownToken.rows[0].name,
    token_symbol: knownToken.rows[0].symbol,
  };
}

export async function listSubscriptions(walletAddress) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const result = await query(
    `SELECT ss.*, t.name AS token_name, t.symbol AS token_symbol
     FROM snap_subscriptions ss
     LEFT JOIN tokens t
       ON t.chain_id = ss.chain_id AND t.token_address = ss.token_address
     WHERE ss.wallet_address = $1 AND ss.chain_id = $2
     ORDER BY ss.updated_at DESC`,
    [wallet, config.chainId],
  );
  return result.rows;
}

export async function communicationInbox(walletAddress) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const result = await query(
    `SELECT c.*, e.chain_id, e.title AS event_title, e.token_symbol,
            e.contract_address, e.creator_address AS event_creator,
            e.authenticity_status, e.snap_delivery_mode, ss.categories
     FROM communications c
     JOIN events e ON e.id = c.event_id
     LEFT JOIN snapshot_entries se
       ON se.event_id = e.id AND se.wallet_address = $1
     LEFT JOIN votes v
       ON v.event_id = e.id AND v.voter_address = $1
     LEFT JOIN communication_deliveries cd
       ON cd.communication_id = c.id AND cd.wallet_address = $1
     LEFT JOIN snap_subscriptions ss
       ON ss.wallet_address = $1
      AND ss.chain_id = e.chain_id
      AND ss.token_address = e.token_address
      AND ss.status = 'ACTIVE'
     WHERE c.status = 'PUBLISHED'
       AND c.published_at <= now()
       AND c.expires_at > now()
       AND cd.communication_id IS NULL
       AND e.snap_delivery_mode <> 'DISABLED'
       AND (
         e.snap_delivery_mode = 'ELIGIBLE'
         OR (e.snap_delivery_mode = 'SUBSCRIBERS_ONLY' AND ss.wallet_address IS NOT NULL)
       )
       AND (
         (c.audience = 'ALL_ELIGIBLE' AND se.wallet_address IS NOT NULL)
         OR (c.audience = 'NOT_VOTED' AND se.wallet_address IS NOT NULL AND v.voter_address IS NULL)
         OR (c.audience = 'SUBSCRIBERS' AND ss.wallet_address IS NOT NULL)
       )
       AND (
         ss.wallet_address IS NULL
         OR c.category = ANY(ss.categories)
       )
     ORDER BY c.published_at DESC
     LIMIT 100`,
    [wallet],
  );

  return result.rows.map((row) => ({
    chainId: Number(row.chain_id),
    eventId: row.event_id,
    eventTitle: row.event_title,
    tokenSymbol: row.token_symbol,
    contractAddress: row.contract_address,
    creatorAddress: row.event_creator,
    messageId: row.message_id,
    title: row.title,
    body: row.body,
    category: row.category,
    audience: row.audience,
    publishedAt: new Date(row.published_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    actionUrl: row.action_url,
    signingMessage: row.signing_message,
    signature: row.creator_signature,
    authenticityStatus: row.authenticity_status,
  }));
}

export async function markCommunicationsDelivered(walletAddress, messageIds) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  if (!Array.isArray(messageIds) || messageIds.length === 0) return { delivered: 0 };
  const result = await query(
    `INSERT INTO communication_deliveries (communication_id, wallet_address)
     SELECT id, $1 FROM communications WHERE message_id = ANY($2::uuid[])
     ON CONFLICT DO NOTHING`,
    [wallet, messageIds],
  );
  return { delivered: result.rowCount };
}
