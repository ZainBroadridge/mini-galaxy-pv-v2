const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SESSION_KEY = 'pv_v2_wallet_session';

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `API request failed with status ${status}.`);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code || 'API_ERROR';
    this.details = payload?.error?.details;
  }
}

export function getStoredSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value?.token || !value?.walletAddress || new Date(value.expiresAt).getTime() <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return value;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function storeSession(session) {
  if (!session) sessionStorage.removeItem(SESSION_KEY);
  else sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function api(path, options = {}) {
  const session = getStoredSession();
  const headers = new Headers(options.headers || {});
  let body = options.body;
  if (body !== undefined && !(body instanceof FormData) && typeof body !== 'string') {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(body);
  } else if (typeof body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (session?.token) headers.set('authorization', `Bearer ${session.token}`);

  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers, body });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

export async function pollJob(jobId, {
  onUpdate,
  timeout = 300_000,
  interval = 1_200,
} = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const job = await api(`/v1/jobs/${jobId}`);
    onUpdate?.(job);
    if (job.status === 'COMPLETED') return job;
    if (job.status === 'FAILED') throw new Error(job.lastError || 'Background job failed.');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('The job is still running. Reopen this page to continue tracking it.');
}

export { API_BASE_URL };
