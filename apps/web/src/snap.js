import { getAddress, verifyMessage } from 'ethers';
import { buildCommunicationSigningMessage } from '@pv/shared';
import { api } from './api.js';

export const SNAP_ID = import.meta.env.VITE_SNAP_ID || 'local:http://localhost:8080';
export const SNAP_VERSION = import.meta.env.VITE_SNAP_VERSION || '*';

function metamask() {
  if (!window.ethereum?.request) throw new Error('MetaMask is required for Snap communications.');
  return window.ethereum;
}

export async function installedSnaps() {
  return metamask().request({ method: 'wallet_getSnaps' });
}

export async function installedSnap() {
  const snaps = await installedSnaps();
  return snaps?.[SNAP_ID] ?? null;
}

export async function isSnapInstalled() {
  return Boolean(await installedSnap());
}

export async function installSnap() {
  const result = await metamask().request({
    method: 'wallet_requestSnaps',
    params: { [SNAP_ID]: SNAP_ID.startsWith('local:') ? {} : { version: SNAP_VERSION } },
  });
  return result?.[SNAP_ID] ?? null;
}

export async function invokeSnap(method, params = undefined) {
  return metamask().request({
    method: 'wallet_snap',
    params: {
      snapId: SNAP_ID,
      request: params === undefined ? { method } : { method, params },
    },
  });
}

export async function syncSnapInbox({
  walletAddress,
  ensureAuthenticated,
  install = false,
}) {
  await ensureAuthenticated();
  let snap = await installedSnap();
  if (!snap && install) snap = await installSnap();
  if (!snap) return { installed: false, fetched: 0, verified: 0, accepted: [] };

  const messages = await api('/v1/communications/inbox');
  // The Snap performs the authoritative signature check. This dApp-side pass
  // avoids forwarding obviously malformed messages and improves UX.
  const verified = messages.filter((message) => {
    try {
      const recovered = getAddress(
        verifyMessage(buildCommunicationSigningMessage(message), message.signature),
      ).toLowerCase();
      return recovered === getAddress(message.creatorAddress).toLowerCase();
    } catch {
      return false;
    }
  });

  await invokeSnap('setWalletContext', { walletAddress });
  const result = await invokeSnap('ingestCommunications', { messages: verified });
  const accepted = result?.acceptedMessageIds ?? result?.accepted ?? [];
  const acknowledged = result?.acknowledgedMessageIds ?? accepted;
  if (acknowledged.length) {
    await api('/v1/communications/delivered', {
      method: 'POST',
      body: { messageIds: acknowledged },
    });
  }
  return {
    installed: true,
    fetched: messages.length,
    verified: verified.length,
    ...result,
    accepted,
    acknowledged,
  };
}
