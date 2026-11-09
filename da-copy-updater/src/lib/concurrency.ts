// Adapted from pdp-document-generator/src/lib/concurrency.ts (runBatch, sleep), with abort support
// and timers that keep their cadence while the tab is in the background.

// Chrome throttles chained setTimeout calls in hidden tabs to as little as once per minute, which
// would stall job polling and retry backoff during a multi-hour run. Timers inside a Web Worker are
// not throttled that way, so sleeps are delegated to a tiny worker when one can be created.
let timerWorker: Worker | null | undefined;
let timerSeq = 0;
const timerCallbacks = new Map<number, () => void>();

function getTimerWorker(): Worker | null {
  if (timerWorker !== undefined) return timerWorker;
  try {
    const src = 'onmessage = (e) => { setTimeout(() => postMessage(e.data.id), e.data.ms); };';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    timerWorker = new Worker(url);
    timerWorker.onmessage = (e: MessageEvent<number>) => {
      const cb = timerCallbacks.get(e.data);
      timerCallbacks.delete(e.data);
      cb?.();
    };
  } catch {
    timerWorker = null;
  }
  return timerWorker;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      timerCallbacks.delete(id);
      clearTimeout(fallback);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const id = ++timerSeq;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const worker = typeof Worker !== 'undefined' ? getTimerWorker() : null;
    if (worker) {
      timerCallbacks.set(id, done);
      worker.postMessage({ id, ms });
    } else {
      fallback = setTimeout(done, ms);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn` over `items` with a fixed-size worker pool. Workers stop taking new items once `signal`
 * aborts. `fn` is expected to handle its own per-item errors; anything it throws (e.g. an auth
 * error) stops the pool and is rethrown.
 */
export async function runPool<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<void>,
  concurrency: number,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  async function worker() {
    while (next < items.length && !signal?.aborted && failure === null) {
      const idx = next++;
      try {
        await fn(items[idx], idx);
      } catch (err) {
        failure ??= err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure !== null) throw failure;
}
