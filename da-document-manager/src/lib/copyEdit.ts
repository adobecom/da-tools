import { cat, createVersion, listVersions, readVersion, writeSource } from '../api/daApi';
import { runBatch } from './concurrency';
import { classify } from './classify';
import type { CopyPreset } from './copyPresets';
import { classifyFragmentSwap } from './fragmentSwap';

/** `dry-run` predicts what Update would do (same matching), without writing anything. */
export type CopyDirection = 'update' | 'rollback' | 'dry-run';

/** How Update edits a document: replace the row's text, or replace the whole block with a fragment. */
export type CopyMode = 'text' | 'fragment';

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
  mode?: CopyMode;
  outcome: CopyOutcome;
  detail?: string;
}

// Each document is read, versioned, written, and read back (4+ DA calls). DA's source API tolerates
// far more than the AEM admin API, and fetchWithRetry backs off on 429/5xx.
export const COPY_EDIT_CONCURRENCY = 16;

export function copyResultLabel(r: CopyResult): string {
  switch (r.outcome) {
    case 'changed':
      if (r.direction === 'rollback') return 'Rolled back';
      if (r.direction === 'dry-run') return r.mode === 'fragment' ? 'Would replace with fragment' : 'Would update';
      return r.mode === 'fragment' ? 'Replaced with fragment' : 'Updated';
    case 'unchanged':
      if (r.direction === 'rollback') return 'Already original';
      return r.mode === 'fragment' ? 'Already uses fragment' : 'Already updated';
    case 'variant': return 'Different wording';
    case 'no-block': return 'No matching block';
    case 'no-match': return 'No matching row';
    case 'ambiguous': return 'Ambiguous';
    case 'no-version': return 'No saved version';
    case 'error': return 'Error';
  }
}

type Outcome = Omit<CopyResult, 'direction' | 'mode'>;

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
 * Update, fragment mode: replace the whole block with a `fragment` block linking to the preset's
 * fragment. Same safety as text mode: a labeled DA version first, then write and read back.
 */
export async function applyFragmentSwap(path: string, preset: CopyPreset): Promise<Outcome> {
  const swap = preset.fragment;
  if (!swap) return { outcome: 'error', detail: 'This preset has no fragment option' };
  const html = await cat(path);
  const c = classifyFragmentSwap(html, swap);
  if (c.outcome === 'already-swapped') return { outcome: 'unchanged' };
  if (c.outcome !== 'match') return { outcome: c.outcome, detail: c.detail };
  await createVersion(path, swap.versionLabel);
  await writeSource(path, c.newHtml!);
  const check = classifyFragmentSwap(await cat(path), swap);
  if (check.outcome !== 'already-swapped') return { outcome: 'error', detail: `Verify failed: document reads back as "${check.outcome}"` };
  return { outcome: 'changed' };
}

/**
 * Dry run: read the document and classify it exactly as Update would, without saving a version or
 * writing. `changed` means Update would edit it.
 */
export async function dryRunUpdate(path: string, preset: CopyPreset, mode: CopyMode): Promise<Outcome> {
  const html = await cat(path);
  if (mode === 'fragment') {
    if (!preset.fragment) return { outcome: 'error', detail: 'This preset has no fragment option' };
    const c = classifyFragmentSwap(html, preset.fragment);
    if (c.outcome === 'already-swapped') return { outcome: 'unchanged' };
    if (c.outcome !== 'match') return { outcome: c.outcome, detail: c.detail };
    return { outcome: 'changed' };
  }
  const c = classify(html, preset.update);
  if (c.outcome === 'already-updated') return { outcome: 'unchanged' };
  if (c.outcome !== 'match') return { outcome: c.outcome, detail: c.detail };
  return { outcome: 'changed' };
}

const MAX_VERSIONS_TO_TRY = 5;

/**
 * Rollback: restore the most recent DA version saved by Update (text or fragment mode) whose content
 * differs from the current document, replacing the whole document. Edits made after that update are
 * discarded; a `rollbackVersionLabel` version is saved first so the rollback can itself be undone.
 * Running it again steps back one more update (e.g. fragment swap → text update → original).
 */
export async function applyRollback(path: string, preset: CopyPreset): Promise<Outcome> {
  const rule = preset.update;
  const current = await cat(path);
  if (classify(current, rule).outcome === 'match') return { outcome: 'unchanged' };
  const labels = new Set([rule.versionLabel, preset.fragment?.versionLabel].filter(Boolean));
  const candidates = (await listVersions(path))
    .filter((v) => v.url && v.label && labels.has(v.label))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, MAX_VERSIONS_TO_TRY);
  if (candidates.length === 0) return { outcome: 'no-version', detail: `No "${[...labels].join('" or "')}" version in DA history` };
  for (const v of candidates) {
    const saved = await readVersion(v.url!);
    if (saved === current) continue;
    const savedState = classify(saved, rule).outcome;
    if (savedState !== 'match' && savedState !== 'already-updated') continue;
    await createVersion(path, preset.rollbackVersionLabel);
    await writeSource(path, saved);
    const check = classify(await cat(path), rule).outcome;
    if (check !== savedState) return { outcome: 'error', detail: `Verify failed: document reads back as "${check}"` };
    return { outcome: 'changed', detail: `Restored "${v.label}" version` };
  }
  return { outcome: 'no-version', detail: 'No saved version differs from the current document' };
}

/**
 * Run Update or Rollback over many documents. Results are reported in batches (`onResults`) rather
 * than per document, so a large folder doesn't re-render the whole table thousands of times.
 */
export async function runCopyBulk(
  paths: string[],
  preset: CopyPreset,
  direction: CopyDirection,
  mode: CopyMode,
  onResults: (results: Map<string, CopyResult>) => void,
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, CopyResult>> {
  const apply = direction === 'rollback' ? applyRollback
    : direction === 'dry-run' ? (path: string, p: CopyPreset) => dryRunUpdate(path, p, mode)
      : mode === 'fragment' ? applyFragmentSwap : applyUpdate;
  const resultMode = direction === 'rollback' ? undefined : mode;
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
        result = { direction, mode: resultMode, ...(await apply(path, preset)) };
      } catch (err) {
        result = { direction, mode: resultMode, outcome: 'error', detail: err instanceof Error ? err.message : String(err) };
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
