import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { assertConfig, config } from './config.js';
import { createNonce, optionalAuth, requireAuth, revokeSession, verifyNonce } from './auth.js';
import {
  communicationInbox,
  listEventCommunications,
  listSubscriptions,
  markCommunicationsDelivered,
  prepareCommunication,
  publishCommunication,
  upsertSubscription,
} from './communications.js';
import { db, query } from './db.js';
import { asyncRoute, bearerToken, HttpError, normalizeUuid } from './errors.js';
import {
  createEvent,
  getEligibility,
  getEvent,
  listCreatedEvents,
  listEligibleEvents,
  listPublicEvents,
  retryDeployment,
  retrySnapshot,
} from './events.js';
import { getJob } from './jobs.js';
import { provider } from './provider.js';
import { inspectStandardToken } from './tokens.js';
import {
  choicesSchema,
  communicationDraftSchema,
  communicationPublishSchema,
  createEventSchema,
  submitVoteSchema,
  subscriptionSchema,
} from './validation.js';
import { getResults, getVote, prepareBallot, retryBallot, submitBallot } from './votes.js';

assertConfig();
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.webOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    return callback(new HttpError(403, 'Origin is not allowed by CORS_ORIGINS.', 'ORIGIN_NOT_ALLOWED'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
}));
app.use(optionalAuth);

for (const parameterName of ['eventId', 'jobId']) {
  app.param(parameterName, (request, _response, next, value) => {
    try {
      request.params[parameterName] = normalizeUuid(value, parameterName);
      next();
    } catch (error) {
      next(error);
    }
  });
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      400,
      result.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '),
      'VALIDATION_FAILED',
      result.error.flatten(),
    );
  }
  return result.data;
}

app.get('/health', asyncRoute(async (_request, response) => {
  const [database, blockNumber, heartbeat] = await Promise.all([
    query('SELECT now() AS now'),
    provider.getBlockNumber(),
    query('SELECT * FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1'),
  ]);
  response.json({
    ok: true,
    service: 'pv-v2-api',
    chainId: config.chainId,
    latestBlock: blockNumber,
    databaseTime: database.rows[0].now,
    worker: heartbeat.rows[0] ?? null,
  });
}));

app.post('/v1/auth/nonce', asyncRoute(async (request, response) => {
  const body = parse(z.object({ walletAddress: z.string().min(1) }), request.body);
  response.json(await createNonce(body.walletAddress));
}));

app.post('/v1/auth/verify', asyncRoute(async (request, response) => {
  const body = parse(z.object({
    walletAddress: z.string().min(1),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  }), request.body);
  response.json(await verifyNonce(body.walletAddress, body.signature));
}));

app.get('/v1/auth/session', requireAuth, asyncRoute(async (request, response) => {
  response.json({ walletAddress: request.auth.wallet_address, expiresAt: request.auth.expires_at });
}));

app.post('/v1/auth/logout', asyncRoute(async (request, response) => {
  await revokeSession(bearerToken(request));
  response.status(204).end();
}));

app.post('/v1/tokens/inspect', asyncRoute(async (request, response) => {
  const body = parse(z.object({ tokenAddress: z.string().min(1) }), request.body);
  response.json(await inspectStandardToken(body.tokenAddress));
}));

app.post('/v1/events', requireAuth, asyncRoute(async (request, response) => {
  const body = parse(createEventSchema, request.body);
  response.status(201).json(await createEvent(request.auth.wallet_address, body));
}));

app.get('/v1/events', asyncRoute(async (request, response) => {
  const scope = ['ongoing', 'completed', 'all'].includes(request.query.scope)
    ? request.query.scope
    : 'ongoing';
  response.json(await listPublicEvents(scope));
}));

app.get('/v1/events/created', requireAuth, asyncRoute(async (request, response) => {
  response.json(await listCreatedEvents(request.auth.wallet_address));
}));

app.get('/v1/wallets/:wallet/events', asyncRoute(async (request, response) => {
  const scope = ['ongoing', 'completed', 'all'].includes(request.query.scope)
    ? request.query.scope
    : 'ongoing';
  response.json(await listEligibleEvents(request.params.wallet, scope));
}));

app.get('/v1/jobs/:jobId', asyncRoute(async (request, response) => {
  response.json(await getJob(request.params.jobId));
}));

app.get('/v1/events/:eventId', asyncRoute(async (request, response) => {
  response.json(await getEvent(request.params.eventId));
}));

app.get('/v1/events/:eventId/eligibility/:wallet', asyncRoute(async (request, response) => {
  response.json(await getEligibility(request.params.eventId, request.params.wallet));
}));

app.post('/v1/events/:eventId/retry-snapshot', requireAuth, asyncRoute(async (request, response) => {
  response.status(202).json(await retrySnapshot(request.params.eventId, request.auth.wallet_address));
}));

app.post('/v1/events/:eventId/retry-deployment', requireAuth, asyncRoute(async (request, response) => {
  response.status(202).json(
    await retryDeployment(request.params.eventId, request.auth.wallet_address),
  );
}));

app.post('/v1/events/:eventId/ballot', requireAuth, asyncRoute(async (request, response) => {
  const body = parse(choicesSchema, request.body);
  response.json(await prepareBallot(request.params.eventId, request.auth.wallet_address, body.choices));
}));

app.post('/v1/events/:eventId/votes', requireAuth, asyncRoute(async (request, response) => {
  const body = parse(submitVoteSchema, request.body);
  response.status(202).json(
    await submitBallot(
      request.params.eventId,
      request.auth.wallet_address,
      body.choices,
      body.signature,
    ),
  );
}));

app.post('/v1/events/:eventId/votes/retry', requireAuth, asyncRoute(async (request, response) => {
  response.status(202).json(
    await retryBallot(request.params.eventId, request.auth.wallet_address),
  );
}));

app.get('/v1/events/:eventId/votes/:wallet', asyncRoute(async (request, response) => {
  response.json(await getVote(request.params.eventId, request.params.wallet));
}));

app.get('/v1/events/:eventId/results', asyncRoute(async (request, response) => {
  response.json(await getResults(request.params.eventId));
}));

app.get('/v1/events/:eventId/communications', requireAuth, asyncRoute(async (request, response) => {
  response.json(await listEventCommunications(request.params.eventId, request.auth.wallet_address));
}));

app.post('/v1/events/:eventId/communications/payload', requireAuth, asyncRoute(async (request, response) => {
  const body = parse(communicationDraftSchema, request.body);
  response.json(await prepareCommunication(request.params.eventId, request.auth.wallet_address, body));
}));

app.post('/v1/events/:eventId/communications', requireAuth, asyncRoute(async (request, response) => {
  const body = parse(communicationPublishSchema, request.body);
  response.status(201).json(
    await publishCommunication(request.params.eventId, request.auth.wallet_address, body),
  );
}));

app.get('/v1/snap/subscriptions', requireAuth, asyncRoute(async (request, response) => {
  response.json(await listSubscriptions(request.auth.wallet_address));
}));

app.post('/v1/snap/subscriptions', requireAuth, asyncRoute(async (request, response) => {
  const body = parse(subscriptionSchema, request.body);
  response.json(await upsertSubscription(request.auth.wallet_address, body));
}));

app.get('/v1/communications/inbox', requireAuth, asyncRoute(async (request, response) => {
  response.json(await communicationInbox(request.auth.wallet_address));
}));

app.post('/v1/communications/delivered', requireAuth, asyncRoute(async (request, response) => {
  const body = parse(z.object({ messageIds: z.array(z.string().uuid()).max(100) }), request.body);
  response.json(await markCommunicationsDelivered(request.auth.wallet_address, body.messageIds));
}));

app.use((request, _response, next) => {
  next(new HttpError(404, `Route not found: ${request.method} ${request.path}`, 'NOT_FOUND'));
});

app.use((error, _request, response, _next) => {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error(error);
  response.status(status).json({
    error: {
      code: error.code ?? 'INTERNAL_ERROR',
      message: status >= 500 ? 'The server could not complete the request.' : error.message,
      details: error.details,
    },
  });
});

const server = app.listen(config.port, () => {
  console.log(`PV V2 API listening on port ${config.port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received; closing API.`);
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
