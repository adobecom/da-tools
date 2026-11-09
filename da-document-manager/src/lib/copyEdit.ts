import { cat, createVersion, writeSource } from '../api/daApi';
import { runBatch } from './concurrency';
import { classify } from './classify';
import type { ReplaceRule } from './copyPresets';

export type CopyDirection = 'update' | 'revert';

export type CopyOutcome = 'changed' | 'unchanged' | 'variant' | 'no-block' | 'no-match' | 'ambiguous' | 'error';

export interface CopyResult {
  direction: CopyDirection;
  outcome: CopyOutcome;
  detail?: string;
}

// Each document is read, versioned, written, and read back (4 DA calls). DA's source API tolerates
// far more than the AEM admin API, and fetchWithRetry backs off on 429/5xx.
export const COPY_EDIT_CONCURRENCY = 16;

export function copyResultLabel(r: CopyResult): string {
  switch (r.outcome) {
    case 'changed': return r.direction === 'update' ? 'Updated' : 'Reverted';
    case 'unchanged': return r.direction === 'update' ? 'Already updated' : 'Already original';
    case 'variant': return 'Different wording';
    case 'no-block': return 'No matching block';
    case 'no-match': return 'No matching row';
    case 'ambiguous': return 'Ambiguous';
    case 'error': return 'Error';
  }
}

/**
 * Apply one rule to one document: only an exact single match is edited. A DA version is saved
 * first, and the result is read back to confirm the new text landed. Re-running is safe: a document
 * that already has the replacement reports `unchanged` and isn't written.
 */
export async function applyRule(path: string, rule: ReplaceRule): Promise<Omit<CopyResult, 'direction'>> {
  const html = await cat(path);
  const c = classify(html, rule);
  if (c.outcome === 'already-updated') return { outcome: 'unchanged' };
  if (c.outcome !== 'match') return { outcome: c.outcome, detail: c.detail };
  await createVersion(path, rule.versionLabel);
  await writeSource(path, c.newHtml!);
  const check = classify(await cat(path), rule);
  if (check.outcome !== 'already-updated') return { outcome: 'error', detail: `Verify failed: document reads back as "${check.outcome}"` };
  return { outcome: 'changed' };
}

/**
 * Apply a rule to many documents. Results are reported in batches (`onResults`) rather than per
 * document, so a large folder doesn't re-render the whole table thousands of times.
 */
export async function applyRuleBulk(
  paths: string[],
  rule: ReplaceRule,
  direction: CopyDirection,
  onResults: (results: Map<string, CopyResult>) => void,
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, CopyResult>> {
  const all = new Map<string, CopyResult>();
  let pending = new Map<string, CopyResult>();
  let done = 0;
  const flush = () => {
    if (pending.size === 0) return;
    onResults(pending);
    pending = new Map();
    onProgress(done, paths.length);
  };
  const timer = setInterval(flush, 400);
  try {
    await runBatch(paths, async (path) => {
      let result: CopyResult;
      try {
        result = { direction, ...(await applyRule(path, rule)) };
      } catch (err) {
        result = { direction, outcome: 'error', detail: err instanceof Error ? err.message : String(err) };
      }
      all.set(path, result);
      pending.set(path, result);
      done += 1;
    }, COPY_EDIT_CONCURRENCY);
  } finally {
    clearInterval(timer);
    flush();
  }
  return all;
}
