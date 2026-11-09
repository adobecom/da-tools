import { cat, createVersion, findVersionUrl, readVersion, writeSource } from '../api/daApi';
import { runBatch } from './concurrency';
import { classify } from './classify';
import type { CopyPreset } from './copyPresets';

export type CopyDirection = 'update' | 'rollback';

export type CopyOutcome =
  | 'changed'
  | 'unchanged'
  | 'variant'
  | 'no-block'
  | 'no-match'
  | 'ambiguous'
  | 'no-version'
  | 'error';

export interface CopyResult {
  direction: CopyDirection;
  outcome: CopyOutcome;
  detail?: string;
}

// Each document is read, versioned, written, and read back (4+ DA calls). DA's source API tolerates
// far more than the AEM admin API, and fetchWithRetry backs off on 429/5xx.
export const COPY_EDIT_CONCURRENCY = 16;

export function copyResultLabel(r: CopyResult): string {
  switch (r.outcome) {
    case 'changed': return r.direction === 'update' ? 'Updated' : 'Rolled back';
    case 'unchanged': return r.direction === 'update' ? 'Already updated' : 'Already original';
    case 'variant': return 'Different wording';
    case 'no-block': return 'No matching block';
    case 'no-match': return 'No matching row';
    case 'ambiguous': return 'Ambiguous';
    case 'no-version': return 'No saved version';
    case 'error': return 'Error';
  }
}

type Outcome = Omit<CopyResult, 'direction'>;

/**
 * Update: apply the preset's rule. Only an exact single match is edited; a DA version labeled
 * `update.versionLabel` is saved right before the write, and the result is read back to verify.
 * Re-running is safe: a document that already has the new text reports `unchanged`.
 */
export async function applyUpdate(path: string, preset: CopyPreset): Promise<Outcome> {
  const rule = preset.update;
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
 * Rollback: restore the most recent DA version labeled `update.versionLabel` (the content saved right
 * before the update), replacing the whole document. Any edits made after the update are discarded;
 * a `rollbackVersionLabel` version is saved first so the rollback itself can be undone from DA history.
 */
export async function applyRollback(path: string, preset: CopyPreset): Promise<Outcome> {
  const rule = preset.update;
  const current = await cat(path);
  if (classify(current, rule).outcome === 'match') return { outcome: 'unchanged' };
  const url = await findVersionUrl(path, rule.versionLabel);
  if (!url) return { outcome: 'no-version', detail: `No "${rule.versionLabel}" version in DA history` };
  const saved = await readVersion(url);
  if (classify(saved, rule).outcome !== 'match') {
    return { outcome: 'error', detail: `The "${rule.versionLabel}" version doesn't contain "${rule.find}"` };
  }
  await createVersion(path, preset.rollbackVersionLabel);
  await writeSource(path, saved);
  const check = classify(await cat(path), rule);
  if (check.outcome !== 'match') return { outcome: 'error', detail: `Verify failed: document reads back as "${check.outcome}"` };
  return { outcome: 'changed' };
}

/**
 * Run Update or Rollback over many documents. Results are reported in batches (`onResults`) rather
 * than per document, so a large folder doesn't re-render the whole table thousands of times.
 */
export async function runCopyBulk(
  paths: string[],
  preset: CopyPreset,
  direction: CopyDirection,
  onResults: (results: Map<string, CopyResult>) => void,
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, CopyResult>> {
  const apply = direction === 'update' ? applyUpdate : applyRollback;
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
        result = { direction, ...(await apply(path, preset)) };
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
