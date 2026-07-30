import { getAddress } from 'ethers';

export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED', details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export function normalizeAddress(value, fieldName = 'address') {
  try {
    return getAddress(String(value)).toLowerCase();
  } catch {
    throw new HttpError(400, `${fieldName} is not a valid EVM address.`, 'INVALID_ADDRESS');
  }
}


export function normalizeUuid(value, fieldName = 'id') {
  const normalized = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new HttpError(400, `${fieldName} is not a valid UUID.`, 'INVALID_ID');
  }
  return normalized;
}

export function bearerToken(request) {
  const header = request.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
}
