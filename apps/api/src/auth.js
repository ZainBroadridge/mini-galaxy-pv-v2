import { createHash, randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { config } from './config.js';
import { query, transaction } from './db.js';
import { bearerToken, HttpError, normalizeAddress } from './errors.js';

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function authenticationMessage({ walletAddress, nonce, expiresAt }) {
  return [
    'Mini Galaxy Proxy Voting V2',
    '',
    'Sign this message to authenticate. It does not create a transaction or spend POL.',
    '',
    `Wallet: ${walletAddress}`,
    `Chain ID: ${config.chainId}`,
    `Nonce: ${nonce}`,
    `Expires At: ${expiresAt.toISOString()}`,
  ].join('\n');
}

export async function createNonce(walletAddress) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  const nonce = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + config.nonceTtlMinutes * 60_000);
  const message = authenticationMessage({ walletAddress: wallet, nonce, expiresAt });

  await transaction(async (client) => {
    await client.query(
      `UPDATE auth_nonces SET used_at = now()
       WHERE wallet_address = $1 AND used_at IS NULL`,
      [wallet],
    );
    await client.query(
      `INSERT INTO auth_nonces (wallet_address, nonce, message, expires_at)
       VALUES ($1,$2,$3,$4)`,
      [wallet, nonce, message, expiresAt],
    );
  });
  return { walletAddress: wallet, message, expiresAt };
}

export async function verifyNonce(walletAddress, signature) {
  const wallet = normalizeAddress(walletAddress, 'walletAddress');
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM auth_nonces
       WHERE wallet_address = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC FOR UPDATE LIMIT 1`,
      [wallet],
    );
    if (!result.rowCount) {
      throw new HttpError(401, 'Authentication challenge is missing or expired.', 'AUTH_CHALLENGE_EXPIRED');
    }

    let recovered;
    try {
      recovered = normalizeAddress(verifyMessage(result.rows[0].message, signature));
    } catch {
      throw new HttpError(401, 'Authentication signature is invalid.', 'INVALID_SIGNATURE');
    }
    if (recovered !== wallet) {
      throw new HttpError(401, 'Authentication signature does not match the wallet.', 'SIGNER_MISMATCH');
    }

    await client.query('UPDATE auth_nonces SET used_at = now() WHERE id = $1', [result.rows[0].id]);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3_600_000);
    await client.query(
      `INSERT INTO sessions (token_hash, wallet_address, expires_at)
       VALUES ($1,$2,$3)`,
      [hashToken(token), wallet, expiresAt],
    );
    return { token, walletAddress: wallet, expiresAt };
  });
}

export async function optionalAuth(request, _response, next) {
  try {
    const token = bearerToken(request);
    if (!token) return next();
    const result = await query(
      `UPDATE sessions SET last_seen_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING wallet_address, expires_at`,
      [hashToken(token)],
    );
    if (result.rowCount) request.auth = result.rows[0];
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAuth(request, _response, next) {
  if (!request.auth) {
    return next(new HttpError(401, 'Connect and authenticate your wallet first.', 'AUTH_REQUIRED'));
  }
  return next();
}

export async function revokeSession(token) {
  if (!token) return;
  await query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [hashToken(token)]);
}
