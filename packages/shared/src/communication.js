import { keccak256, toUtf8Bytes } from 'ethers';

function oneLine(value) {
  return String(value ?? '').trim().replace(/\r?\n/g, ' ');
}

export function communicationBodyHash(body) {
  return keccak256(toUtf8Bytes(String(body ?? '').replace(/\r\n/g, '\n')));
}

/**
 * Produce the exact human-readable message signed by an event creator.
 * The Snap rebuilds this value from the received fields before recovering the
 * signer, so an API or database compromise cannot silently alter displayed
 * content, trust labels, expiry, or the dApp action link.
 */
export function buildCommunicationSigningMessage(message) {
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
    `bodyHash:${communicationBodyHash(message.body)}`,
    `category:${oneLine(message.category)}`,
    `audience:${oneLine(message.audience)}`,
    `publishedAt:${oneLine(message.publishedAt)}`,
    `expiresAt:${oneLine(message.expiresAt)}`,
    `actionUrl:${oneLine(message.actionUrl)}`,
  ].join('\n');
}
