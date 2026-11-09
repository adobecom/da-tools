// Adapted from pdp-document-generator/src/lib/http.ts (fetchWithRetry). Additions: a 401 raises
// AuthError so a long run pauses instead of failing every remaining document, transient network
// errors are retried, and requests honor an AbortSignal.
import { sleep } from './concurrency';

export class AuthError extends Error {
  constructor(message = 'DA session expired or not authorized (401)') {
    super(message);
    this.name = 'AuthError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export interface RetryOptions {
  /** Max total attempts, including the first. Default 5. */
  maxAttempts?: number;
  /** Base backoff in ms; grows as baseDelayMs * 2 ** attempt. Default 500. */
  baseDelayMs?: number;
}

const shouldRetry = (resp: Response): boolean => resp.status === 429 || resp.status >= 500;

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const signal = init.signal ?? undefined;

  for (let attempt = 0; ; attempt++) {
    const last = attempt >= maxAttempts - 1;
    let resp: Response;
    try {
      resp = await fetch(input, init);
    } catch (err) {
      if (isAbortError(err) || last) throw err;
      await sleep(baseDelayMs * 2 ** attempt + Math.random() * 300, signal);
      continue;
    }
    if (resp.status === 401) throw new AuthError();
    if (last || !shouldRetry(resp)) return resp;
    const retryAfter = Number(resp.headers.get('retry-after'));
    const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : baseDelayMs * 2 ** attempt;
    await sleep(backoffMs + Math.random() * 300, signal);
  }
}
