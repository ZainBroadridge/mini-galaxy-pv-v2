import type { OnHomePageHandler, OnRpcRequestHandler } from '@metamask/snaps-sdk';
import { UnauthorizedError } from '@metamask/snaps-sdk';
import { Bold, Box, Heading, Link, Text } from '@metamask/snaps-sdk/jsx';
import { getAddress, keccak256, toUtf8Bytes, verifyMessage } from 'ethers';

const AMOY_CHAIN_ID = 80002;
const MAX_STORED_MESSAGES = 100;
const MAX_NOTIFICATIONS_PER_SYNC = 5;
const ALLOWED_CATEGORIES = new Set([
  'EVENT_ANNOUNCEMENT',
  'VOTING_OPEN',
  'DEADLINE_REMINDER',
  'DOCUMENT_UPDATE',
  'RESULTS_AVAILABLE',
  'GENERAL',
]);
const ALLOWED_AUDIENCES = new Set(['ALL_ELIGIBLE', 'NOT_VOTED', 'SUBSCRIBERS']);
const ALLOWED_AUTHENTICITY = new Set([
  'COMMUNITY',
  'SELF_CLAIMED',
  'TOKEN_OWNER_VERIFIED',
  'PLATFORM_VERIFIED',
]);


type Communication = {
  chainId: number;
  messageId: string;
  eventId: string;
  eventTitle: string;
  tokenSymbol: string;
  contractAddress: string;
  creatorAddress: string;
  authenticityStatus: string;
  title: string;
  body: string;
  category: string;
  audience: string;
  publishedAt: string;
  expiresAt: string;
  actionUrl: string;
  signature: string;
  read: boolean;
  receivedAt: string;
};

type SnapState = {
  walletAddress: string | null;
  messages: Communication[];
  updatedAt: string | null;
};

const EMPTY_STATE: SnapState = {
  walletAddress: null,
  messages: [],
  updatedAt: null,
};

async function readState(): Promise<SnapState> {
  const state = await snap.request({
    method: 'snap_manageState',
    params: { operation: 'get' },
  }) as Partial<SnapState> | null;
  return {
    walletAddress: state?.walletAddress ?? null,
    messages: Array.isArray(state?.messages) ? state.messages : [],
    updatedAt: state?.updatedAt ?? null,
  };
}

async function writeState(state: SnapState): Promise<void> {
  await snap.request({
    method: 'snap_manageState',
    params: { operation: 'update', newState: state },
  });
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string, maxLength = 12_000): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requireUuid(value: unknown, name: string): string {
  const text = requireString(value, name, 96);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return text.toLowerCase();
}

function requireAddress(value: unknown, name: string): string {
  try {
    return getAddress(requireString(value, name, 42)).toLowerCase();
  } catch {
    throw new Error(`${name} is not a valid EVM address.`);
  }
}

function requireEnum(value: unknown, name: string, allowed: Set<string>): string {
  const text = requireString(value, name, 64);
  if (!allowed.has(text)) throw new Error(`${name} is unsupported.`);
  return text;
}

function requireIsoDate(value: unknown, name: string): string {
  const text = requireString(value, name, 64);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Error(`${name} is not a valid date.`);
  return new Date(time).toISOString();
}

function oneLine(value: unknown): string {
  return String(value ?? '').trim().replace(/\r?\n/gu, ' ');
}

function bodyHash(body: string): string {
  return keccak256(toUtf8Bytes(body.replace(/\r\n/gu, '\n')));
}

function communicationSigningMessage(message: Omit<Communication, 'read' | 'receivedAt'>): string {
  return [
    'PV_COMMUNICATION_V2',
    `chainId:${oneLine(message.chainId)}`,
    `eventId:${oneLine(message.eventId)}`,
    `eventTitle:${oneLine(message.eventTitle)}`,
    `tokenSymbol:${oneLine(message.tokenSymbol)}`,
    `contract:${oneLine(message.contractAddress).toLowerCase()}`,
    `creator:${oneLine(message.creatorAddress).toLowerCase()}`,
    `authenticityStatus:${oneLine(message.authenticityStatus)}`,
    `messageId:${oneLine(message.messageId)}`,
    `title:${oneLine(message.title)}`,
    `bodyHash:${bodyHash(message.body)}`,
    `category:${oneLine(message.category)}`,
    `audience:${oneLine(message.audience)}`,
    `publishedAt:${oneLine(message.publishedAt)}`,
    `expiresAt:${oneLine(message.expiresAt)}`,
    `actionUrl:${oneLine(message.actionUrl)}`,
  ].join('\n');
}

function normalizeAndVerifyMessage(value: unknown, origin: string): Communication {
  const input = requireObject(value, 'communication');
  const chainId = Number(input.chainId);
  if (chainId !== AMOY_CHAIN_ID) throw new Error('Only Polygon Amoy communications are accepted.');

  const actionUrl = requireString(input.actionUrl, 'actionUrl', 2_000);
  let actionOrigin: string;
  try {
    actionOrigin = new URL(actionUrl).origin;
  } catch {
    throw new Error('actionUrl is invalid.');
  }
  if (actionOrigin !== origin) {
    throw new UnauthorizedError('Communication action URL is outside the connected PV dApp origin.');
  }

  const publishedAt = requireIsoDate(input.publishedAt, 'publishedAt');
  const expiresAt = requireIsoDate(input.expiresAt, 'expiresAt');
  if (Date.parse(publishedAt) > Date.now() + 5 * 60_000) {
    throw new Error('Future communication rejected.');
  }
  if (Date.parse(expiresAt) <= Date.now()) throw new Error('Expired communication rejected.');
  if (Date.parse(expiresAt) <= Date.parse(publishedAt)) {
    throw new Error('Communication expiry must be after publication.');
  }

  const unsigned = {
    chainId,
    messageId: requireUuid(input.messageId, 'messageId'),
    eventId: requireUuid(input.eventId, 'eventId'),
    eventTitle: requireString(input.eventTitle, 'eventTitle', 180),
    tokenSymbol: requireString(input.tokenSymbol, 'tokenSymbol', 40),
    contractAddress: requireAddress(input.contractAddress, 'contractAddress'),
    creatorAddress: requireAddress(input.creatorAddress, 'creatorAddress'),
    authenticityStatus: requireEnum(
      input.authenticityStatus,
      'authenticityStatus',
      ALLOWED_AUTHENTICITY,
    ),
    title: requireString(input.title, 'title', 180),
    body: requireString(input.body, 'body'),
    category: requireEnum(input.category, 'category', ALLOWED_CATEGORIES),
    audience: requireEnum(input.audience, 'audience', ALLOWED_AUDIENCES),
    publishedAt,
    expiresAt,
    actionUrl,
    signature: requireString(input.signature, 'signature', 512),
  };

  const rebuilt = communicationSigningMessage(unsigned);
  const suppliedSigningMessage = requireString(input.signingMessage, 'signingMessage', 20_000);
  if (suppliedSigningMessage !== rebuilt) {
    throw new Error('Communication fields do not match the creator-signed payload.');
  }

  let recovered: string;
  try {
    recovered = getAddress(verifyMessage(rebuilt, unsigned.signature)).toLowerCase();
  } catch {
    throw new Error('Communication creator signature is invalid.');
  }
  if (recovered !== unsigned.creatorAddress) {
    throw new UnauthorizedError('Communication was not signed by the recorded event creator.');
  }

  return {
    ...unsigned,
    read: false,
    receivedAt: new Date().toISOString(),
  };
}

async function notify(message: Communication): Promise<void> {
  const notification = `${message.tokenSymbol}: ${message.title}`.slice(0, 80);
  await snap.request({
    method: 'snap_notify',
    params: {
      type: 'inApp',
      message: notification,
      title: message.title.slice(0, 80),
      content: (
        <Box>
          <Text><Bold>{message.eventTitle}</Bold></Text>
          <Text>{message.body.slice(0, 1_200)}</Text>
          <Text>Creator signature verified</Text>
          <Text>Event trust label: {message.authenticityStatus.replaceAll('_', ' ')}</Text>
        </Box>
      ),
      footerLink: {
        href: message.actionUrl,
        text: 'Open voting event',
      },
    },
  });
}

export const onRpcRequest: OnRpcRequestHandler = async ({ origin, request }) => {
  switch (request.method) {
    case 'ping':
      return { ok: true, version: '0.1.0', chainId: AMOY_CHAIN_ID };

    case 'setWalletContext': {
      const params = requireObject(request.params, 'params');
      const walletAddress = requireAddress(params.walletAddress, 'walletAddress');
      const state = await readState();
      const walletChanged = state.walletAddress !== null && state.walletAddress !== walletAddress;
      await writeState({
        walletAddress,
        messages: walletChanged ? [] : state.messages,
        updatedAt: new Date().toISOString(),
      });
      return { ok: true, walletAddress, walletChanged };
    }

    case 'ingestCommunications': {
      const params = requireObject(request.params, 'params');
      if (!Array.isArray(params.messages) || params.messages.length > 100) {
        throw new Error('messages must be an array containing at most 100 items.');
      }
      const state = await readState();
      if (!state.walletAddress) {
        throw new UnauthorizedError('Set the connected wallet context before syncing messages.');
      }
      const incoming = params.messages.map((message) => normalizeAndVerifyMessage(message, origin));
      const known = new Set(state.messages.map((message) => message.messageId));
      const fresh = incoming.filter((message) => !known.has(message.messageId));
      const messages = [...fresh, ...state.messages].slice(0, MAX_STORED_MESSAGES);
      await writeState({ ...state, messages, updatedAt: new Date().toISOString() });
      for (const message of fresh.slice(0, MAX_NOTIFICATIONS_PER_SYNC)) await notify(message);
      const acceptedMessageIds = fresh.map((message) => message.messageId);
      const acknowledgedMessageIds = incoming.map((message) => message.messageId);
      return {
        accepted: acceptedMessageIds,
        acceptedMessageIds,
        acknowledgedMessageIds,
        total: messages.length,
      };
    }

    case 'getInbox':
      return readState();

    case 'markAsRead': {
      const params = requireObject(request.params, 'params');
      const messageId = requireUuid(params.messageId, 'messageId');
      const state = await readState();
      await writeState({
        ...state,
        messages: state.messages.map((message) => (
          message.messageId === messageId ? { ...message, read: true } : message
        )),
        updatedAt: new Date().toISOString(),
      });
      return { ok: true };
    }

    case 'clearInbox': {
      const state = await readState();
      await writeState({ ...state, messages: [], updatedAt: new Date().toISOString() });
      return { ok: true };
    }

    default:
      throw new Error(`Method not found: ${request.method}`);
  }
};

export const onHomePage: OnHomePageHandler = async () => {
  const state = await readState();
  const unread = state.messages.filter((message) => !message.read).length;
  return {
    content: (
      <Box>
        <Heading>PV Investor Communications</Heading>
        <Text><Bold>{unread}</Bold> unread message(s)</Text>
        {state.messages.length === 0 ? (
          <Text>Open the Mini Galaxy PV dApp to sync creator-signed voting communications.</Text>
        ) : (
          state.messages.slice(0, 10).map((message) => (
            <Box key={message.messageId}>
              <Heading>{message.title}</Heading>
              <Text>{message.eventTitle} · {message.tokenSymbol}</Text>
              <Text>{message.body.slice(0, 500)}</Text>
              <Text>Creator signature verified · {message.authenticityStatus.replaceAll('_', ' ')}</Text>
              <Link href={message.actionUrl}>Open voting event</Link>
            </Box>
          ))
        )}
      </Box>
    ),
  };
};
