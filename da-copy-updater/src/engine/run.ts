import {
  bulkMutate, bulkStatus, crawlDocs, createVersion, fetchLivePlain, findVersionUrl, readSource, readVersion, writeSource,
} from '../api/daApi';
import { runPool } from '../lib/concurrency';
import { isAbortError } from '../lib/http';
import { classify } from './classify';
import type { JournalWriter } from './journal';
import {
  bucketForMatch, hashText, inRollback, productTypeFor, rollbackNeedsPreview, rollbackNeedsPublish,
  UPDATE_BUCKETS, wroteDoc, type DocRecord,
} from './model';
import type { ReplaceRule } from './rule';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export type EngineEvent =
  | { type: 'progress'; label: string; done: number; total: number | null }
  | { type: 'log'; level: LogLevel; msg: string }
  | { type: 'changed' };

export interface PhaseContext {
  rule: ReplaceRule;
  root: string;
  records: Map<string, DocRecord>;
  journal: JournalWriter;
  signal: AbortSignal;
  emit: (e: EngineEvent) => void;
}

const READ_CONCURRENCY = 12;
const WRITE_CONCURRENCY = 8;
const LIVE_CHECK_CONCURRENCY = 16;

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

function isFatal(err: unknown): boolean {
  return isAbortError(err) || (err instanceof Error && err.name === 'AuthError');
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

export type EligiblePhase = 'apply' | 'preview' | 'publish' | 'verify' | 'rollback';

export function eligibleFor(phase: EligiblePhase, records: Iterable<DocRecord>): DocRecord[] {
  const out: DocRecord[] = [];
  for (const r of records) {
    if (phase === 'rollback') {
      if (wroteDoc(r) && r.rollbackStage === undefined) out.push(r);
      else if (r.rollbackStage === 'restored' && rollbackNeedsPreview(r)) out.push(r);
      else if (r.rollbackStage === 'previewed' && rollbackNeedsPublish(r)) out.push(r);
      continue;
    }
    if (inRollback(r)) continue;
    if (phase === 'apply' && UPDATE_BUCKETS.has(r.bucket) && r.stage === 'scanned') out.push(r);
    if (phase === 'preview' && r.bucket === 'update-and-publish' && r.stage === 'updated') out.push(r);
    if (phase === 'publish' && r.stage === 'previewed') out.push(r);
    if (phase === 'verify' && r.stage === 'published' && r.liveVerified !== true) out.push(r);
  }
  return out;
}

/** Phase 1 (read-only): crawl, classify every document, then fetch publish status for matches. */
export async function scan(
  root: string,
  rule: ReplaceRule,
  signal: AbortSignal,
  emit: (e: EngineEvent) => void,
): Promise<DocRecord[]> {
  emit({ type: 'log', level: 'info', msg: `Scanning ${root}` });
  emit({ type: 'progress', label: 'Listing folders', done: 0, total: null });
  const { docs, errors } = await crawlDocs(root, signal, (found, folders) => {
    emit({ type: 'progress', label: `Listing folders (${folders} listed)`, done: found, total: null });
  });
  for (const e of errors) emit({ type: 'log', level: 'error', msg: `Could not list ${e.dirPath}: ${e.message}` });
  emit({ type: 'log', level: 'info', msg: `Found ${docs.length} documents` });

  const records: DocRecord[] = [];
  const matched: DocRecord[] = [];
  let done = 0;
  emit({ type: 'progress', label: 'Reading documents', done: 0, total: docs.length });
  await runPool(docs, async (item) => {
    const rec: DocRecord = {
      path: item.path,
      productType: productTypeFor(item.path, root),
      bucket: 'scan-error',
      stage: 'scanned',
      daLastModified: item.lastModified,
    };
    try {
      const html = await readSource(item.path, signal);
      const c = classify(html, rule);
      rec.hash = hashText(html);
      rec.detail = c.detail;
      if (c.outcome === 'match') {
        rec.bucket = 'skip-status-unknown';
        matched.push(rec);
      } else {
        rec.bucket = c.outcome;
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      rec.detail = errMsg(err);
      emit({ type: 'log', level: 'error', msg: `${item.path}: ${rec.detail}` });
    }
    records.push(rec);
    done += 1;
    emit({ type: 'progress', label: 'Reading documents', done, total: docs.length });
  }, READ_CONCURRENCY, signal);
  throwIfAborted(signal);

  if (matched.length > 0) {
    emit({ type: 'log', level: 'info', msg: `${matched.length} documents match; checking publish status` });
    emit({ type: 'progress', label: 'Checking publish status', done: 0, total: matched.length });
    try {
      const statuses = await bulkStatus(matched.map((r) => r.path), signal, (d, t) => {
        emit({ type: 'progress', label: 'Checking publish status', done: d, total: t });
      });
      for (const rec of matched) {
        const st = statuses.get(rec.path);
        rec.sourceLastModified = st?.sourceLastModified;
        rec.previewLastModified = st?.previewLastModified;
        rec.publishLastModified = st?.publishLastModified;
        rec.bucket = bucketForMatch(st, rec.daLastModified);
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      emit({ type: 'log', level: 'error', msg: `Publish status check failed (${errMsg(err)}); matching documents are marked "status unknown". Re-scan to retry.` });
    }
  }

  records.sort((a, b) => a.path.localeCompare(b.path));
  emit({ type: 'log', level: 'success', msg: 'Scan complete (no documents were changed)' });
  return records;
}

/** Phase 2: save a DA version, write the edit, read it back to verify. */
export async function applyUpdates(ctx: PhaseContext): Promise<void> {
  const { rule, journal, signal, emit } = ctx;
  const todo = eligibleFor('apply', ctx.records.values());
  let done = 0;
  emit({ type: 'log', level: 'info', msg: `Updating ${todo.length} documents` });
  emit({ type: 'progress', label: 'Updating documents', done: 0, total: todo.length });

  await runPool(todo, async (rec) => {
    try {
      const html = await readSource(rec.path, signal);
      const currentHash = hashText(html);
      const c = classify(html, rule);
      const alreadyWrittenByUs = currentHash === rec.pendingHash || currentHash === rec.writtenHash;

      if (!alreadyWrittenByUs) {
        if (currentHash !== rec.hash && rec.bucket === 'update-and-publish') {
          rec.stage = 'skipped';
          rec.skipReason = 'Edited after the scan; re-scan to include it';
        } else if (c.outcome !== 'match') {
          rec.stage = 'skipped';
          rec.skipReason = `Changed after the scan (now: ${c.outcome})`;
        }
        if (rec.stage === 'skipped') {
          emit({ type: 'log', level: 'warn', msg: `Skipped ${rec.path}: ${rec.skipReason}` });
          return;
        }
        // Once a write starts it runs to completion (no abort signal), so a pause can't leave a
        // document half-processed. pendingHash is persisted first so a crash mid-write is recoverable.
        rec.pendingHash = hashText(c.newHtml!);
        await journal.putNow(rec);
        await createVersion(rec.path, rule.versionLabel);
        await writeSource(rec.path, c.newHtml!);
      }

      const readBack = await readSource(rec.path);
      const check = classify(readBack, rule);
      if (check.outcome !== 'already-updated') throw new Error(`verify: document reads back as "${check.outcome}"`);
      rec.writtenHash = hashText(readBack);
      rec.stage = 'updated';
      rec.error = undefined;
    } catch (err) {
      if (isFatal(err)) throw err;
      rec.error = errMsg(err);
      emit({ type: 'log', level: 'error', msg: `${rec.path}: ${rec.error}` });
    } finally {
      journal.put(rec);
      done += 1;
      emit({ type: 'progress', label: 'Updating documents', done, total: todo.length });
      emit({ type: 'changed' });
    }
  }, WRITE_CONCURRENCY, signal);
  throwIfAborted(signal);
  emit({ type: 'log', level: 'success', msg: 'Update step finished' });
}

/**
 * Re-reads each document and keeps only those whose source still hashes to one of `expected`.
 * Anything else was edited by someone after our write and is handed to `onChanged`.
 */
async function unchangedSince(
  ctx: PhaseContext,
  recs: DocRecord[],
  expected: (r: DocRecord) => (string | undefined)[],
  onChanged: (r: DocRecord) => void,
  onError: (r: DocRecord, msg: string) => void,
): Promise<DocRecord[]> {
  const { journal, signal, emit } = ctx;
  const ok: DocRecord[] = [];
  let done = 0;
  emit({ type: 'progress', label: 'Checking for edits since our change', done: 0, total: recs.length });
  await runPool(recs, async (rec) => {
    try {
      const h = hashText(await readSource(rec.path, signal));
      if (expected(rec).includes(h)) {
        ok.push(rec);
      } else {
        onChanged(rec);
        journal.put(rec);
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      onError(rec, `Re-check failed (${errMsg(err)}); retry this step`);
      journal.put(rec);
    }
    done += 1;
    emit({ type: 'progress', label: 'Checking for edits since our change', done, total: recs.length });
  }, READ_CONCURRENCY, signal);
  throwIfAborted(signal);
  return ok;
}

/** Keeps only documents whose source is still exactly what we wrote, so author edits are never pushed. */
function unchangedSinceWrite(ctx: PhaseContext, recs: DocRecord[]): Promise<DocRecord[]> {
  return unchangedSince(
    ctx, recs,
    (r) => [r.writtenHash, r.pendingHash],
    (r) => {
      r.stage = 'skipped';
      r.skipReason = 'Edited by someone else after our update';
      ctx.emit({ type: 'log', level: 'warn', msg: `Skipped ${r.path}: ${r.skipReason}` });
    },
    (r, msg) => { r.error = msg; },
  );
}

function skip(ctx: PhaseContext, rec: DocRecord, reason: string) {
  rec.stage = 'skipped';
  rec.skipReason = reason;
  ctx.journal.put(rec);
  ctx.emit({ type: 'log', level: 'warn', msg: `Skipped ${rec.path}: ${reason}` });
}

const NOT_LIVE = 'No longer live (unpublished after the scan); not republished';

/** Phase 3: bulk preview of updated live pages, confirmed by previewLastModified advancing. */
export async function previewUpdated(ctx: PhaseContext): Promise<void> {
  const { journal, signal, emit } = ctx;
  const candidates = await unchangedSinceWrite(ctx, eligibleFor('preview', ctx.records.values()));
  emit({ type: 'progress', label: 'Checking pages are still live', done: 0, total: candidates.length });
  const pre = await bulkStatus(candidates.map((r) => r.path), signal, (d, t) => emit({ type: 'progress', label: 'Checking pages are still live', done: d, total: t }));
  const todo: DocRecord[] = [];
  for (const rec of candidates) {
    const st = pre.get(rec.path);
    if (!st?.ok) {
      rec.error = 'Publish status unknown; retry the preview step';
      journal.put(rec);
    } else if (st.publishLastModified === undefined) {
      skip(ctx, rec, NOT_LIVE);
    } else {
      todo.push(rec);
    }
  }
  const paths = todo.map((r) => r.path);
  emit({ type: 'log', level: 'info', msg: `Previewing ${todo.length} pages` });
  emit({ type: 'progress', label: 'Previewing', done: 0, total: todo.length });
  await bulkMutate('preview', paths, signal,
    (d, t) => emit({ type: 'progress', label: 'Previewing', done: d, total: t }),
    (msg) => emit({ type: 'log', level: 'warn', msg }));

  emit({ type: 'progress', label: 'Confirming preview', done: 0, total: todo.length });
  const statuses = await bulkStatus(paths, signal, (d, t) => emit({ type: 'progress', label: 'Confirming preview', done: d, total: t }));
  let ok = 0;
  for (const rec of todo) {
    const st = statuses.get(rec.path);
    if (st?.ok && st.previewLastModified && st.previewLastModified > (rec.previewLastModified ?? 0)) {
      rec.stage = 'previewed';
      rec.ourPreviewLastModified = st.previewLastModified;
      rec.error = undefined;
      ok += 1;
    } else {
      rec.error = 'Preview not confirmed; retry the preview step';
    }
    journal.put(rec);
  }
  emit({ type: 'changed' });
  emit({ type: 'log', level: ok === todo.length ? 'success' : 'warn', msg: `Preview confirmed for ${ok}/${todo.length} pages` });
}

/**
 * Phase 4: bulk publish. Right before publishing, each page is re-checked so that edits or
 * re-previews made by someone else after our update are never pushed live.
 */
export async function publishPreviewed(ctx: PhaseContext): Promise<void> {
  const { journal, signal, emit } = ctx;
  const todo = eligibleFor('publish', ctx.records.values());
  emit({ type: 'log', level: 'info', msg: `Re-checking ${todo.length} pages before publishing` });
  emit({ type: 'progress', label: 'Re-checking before publish', done: 0, total: todo.length });
  const pre = await bulkStatus(todo.map((r) => r.path), signal, (d, t) => emit({ type: 'progress', label: 'Re-checking before publish', done: d, total: t }));

  const ready: DocRecord[] = [];
  for (const rec of todo) {
    const st = pre.get(rec.path);
    if (!st?.ok) {
      rec.error = 'Publish status unknown; retry the publish step';
    } else if (st.publishLastModified === undefined) {
      rec.stage = 'skipped';
      rec.skipReason = NOT_LIVE;
    } else if (st.previewLastModified !== rec.ourPreviewLastModified) {
      rec.stage = 'skipped';
      rec.skipReason = 'Previewed again by someone else after our update';
    } else if ((st.sourceLastModified ?? 0) > (st.previewLastModified ?? 0)) {
      rec.stage = 'skipped';
      rec.skipReason = 'Edited after our update';
    } else {
      ready.push(rec);
      continue;
    }
    journal.put(rec);
    if (rec.stage === 'skipped') emit({ type: 'log', level: 'warn', msg: `Skipped ${rec.path}: ${rec.skipReason}` });
  }

  const toPublish = await unchangedSinceWrite(ctx, ready);
  const paths = toPublish.map((r) => r.path);
  emit({ type: 'log', level: 'info', msg: `Publishing ${toPublish.length} pages` });
  emit({ type: 'progress', label: 'Publishing', done: 0, total: toPublish.length });
  await bulkMutate('live', paths, signal,
    (d, t) => emit({ type: 'progress', label: 'Publishing', done: d, total: t }),
    (msg) => emit({ type: 'log', level: 'warn', msg }));

  emit({ type: 'progress', label: 'Confirming publish', done: 0, total: toPublish.length });
  const post = await bulkStatus(paths, signal, (d, t) => emit({ type: 'progress', label: 'Confirming publish', done: d, total: t }));
  let ok = 0;
  for (const rec of toPublish) {
    const st = post.get(rec.path);
    if (st?.ok && st.publishLastModified && st.publishLastModified > (rec.publishLastModified ?? 0)) {
      rec.stage = 'published';
      rec.error = undefined;
      ok += 1;
    } else {
      rec.error = 'Publish not confirmed; retry the publish step';
    }
    journal.put(rec);
  }
  emit({ type: 'changed' });
  emit({ type: 'log', level: ok === toPublish.length ? 'success' : 'warn', msg: `Publish confirmed for ${ok}/${toPublish.length} pages` });
}

/** Phase 5 (read-only): fetch each published page from aem.live and confirm the new copy is live. */
export async function verifyLive(ctx: PhaseContext): Promise<void> {
  const { rule, journal, signal, emit } = ctx;
  const todo = eligibleFor('verify', ctx.records.values());
  let done = 0;
  let ok = 0;
  emit({ type: 'progress', label: 'Checking live pages', done: 0, total: todo.length });
  await runPool(todo, async (rec) => {
    try {
      const html = await fetchLivePlain(rec.path, signal);
      const outcome = html === null ? 'not found' : classify(html, rule).outcome;
      rec.liveVerified = outcome === 'already-updated';
      if (rec.liveVerified) ok += 1;
      else emit({ type: 'log', level: 'warn', msg: `Live check ${rec.path}: ${outcome}` });
    } catch (err) {
      if (isFatal(err)) throw err;
      rec.liveVerified = false;
      emit({ type: 'log', level: 'error', msg: `Live check ${rec.path}: ${errMsg(err)}` });
    }
    journal.put(rec);
    done += 1;
    emit({ type: 'progress', label: 'Checking live pages', done, total: todo.length });
  }, LIVE_CHECK_CONCURRENCY, signal);
  throwIfAborted(signal);
  emit({ type: 'changed' });
  emit({ type: 'log', level: ok === todo.length ? 'success' : 'warn', msg: `New copy confirmed live on ${ok}/${todo.length} pages` });
}

function rollbackNote(ctx: PhaseContext, rec: DocRecord, note: string) {
  rec.rollbackNote = note;
  rec.rollbackError = undefined;
  ctx.journal.put(rec);
  ctx.emit({ type: 'log', level: 'warn', msg: `${rec.path}: ${note}` });
}

/**
 * Rollback, step 1: put back the original copy in every document this tool wrote. A document that
 * is unchanged since our write gets its saved "before" version restored exactly. A document someone
 * edited afterwards gets only our heading reverted (their edits are kept) and is never republished.
 */
async function rollbackSources(ctx: PhaseContext): Promise<void> {
  const { rule, journal, signal, emit } = ctx;
  const todo = [...ctx.records.values()].filter((r) => wroteDoc(r) && r.rollbackStage === undefined);
  if (todo.length === 0) return;
  const reverse = { ...rule, find: rule.replace, replace: rule.find };
  let done = 0;
  emit({ type: 'log', level: 'info', msg: `Restoring the original copy in ${todo.length} documents` });
  emit({ type: 'progress', label: 'Restoring documents', done: 0, total: todo.length });

  await runPool(todo, async (rec) => {
    try {
      const html = await readSource(rec.path, signal);
      const h = hashText(html);
      const interruptedWrite = rec.rollbackPendingHash !== undefined && h === rec.rollbackPendingHash;

      if (!interruptedWrite) {
        if (classify(html, rule).outcome === 'match') {
          rec.rollbackMethod = 'already-original';
          rec.rollbackNote = 'Already had the original copy; nothing to restore';
          rec.rollbackHash = h;
          rec.rollbackStage = 'restored';
          rec.rollbackError = undefined;
          return;
        }
        let restored: string | null = null;
        const unchanged = h === rec.writtenHash || h === rec.pendingHash;
        rec.rollbackNote = undefined;
        if (unchanged) {
          const url = await findVersionUrl(rec.path, rule.versionLabel, signal);
          const version = url ? await readVersion(url, signal) : null;
          if (version !== null && classify(version, rule).outcome === 'match') {
            restored = version;
            rec.rollbackMethod = 'version';
          }
        }
        if (restored === null) {
          const r = classify(html, reverse);
          if (r.outcome !== 'match') throw new Error(`can't revert: the updated heading now reads as "${r.outcome}"`);
          restored = r.newHtml!;
          rec.rollbackMethod = 'reverted-copy';
          rec.rollbackNote = unchanged
            ? 'Saved version not found; reverted the copy change only and did not republish'
            : 'Edited after our update; reverted the copy change only (their edits kept) and did not republish';
        }
        rec.rollbackPendingHash = hashText(restored);
        await journal.putNow(rec);
        await createVersion(rec.path, rule.rollbackVersionLabel);
        await writeSource(rec.path, restored);
      }

      const back = await readSource(rec.path);
      if (classify(back, rule).outcome !== 'match') throw new Error('verify: original copy not found after rollback');
      rec.rollbackHash = hashText(back);
      rec.rollbackStage = 'restored';
      rec.rollbackError = undefined;
    } catch (err) {
      if (isFatal(err)) throw err;
      rec.rollbackError = errMsg(err);
      emit({ type: 'log', level: 'error', msg: `Rollback ${rec.path}: ${rec.rollbackError}` });
    } finally {
      journal.put(rec);
      done += 1;
      emit({ type: 'progress', label: 'Restoring documents', done, total: todo.length });
      emit({ type: 'changed' });
    }
  }, WRITE_CONCURRENCY, signal);
  throwIfAborted(signal);
}

const unchangedSinceRollback = (ctx: PhaseContext, recs: DocRecord[], note: string) => unchangedSince(
  ctx, recs,
  (r) => [r.rollbackHash],
  (r) => rollbackNote(ctx, r, note),
  (r, msg) => { r.rollbackError = msg; },
);

/**
 * Rollback, step 2: decide which restored pages need re-preview / re-publish from their current
 * status, not only from what this tool confirmed. A forward preview or publish that ran but was
 * interrupted before confirmation still moved the timestamps past the scan-time values, so those
 * pages are reverted too. The restored content equals the page as it was live at scan time.
 */
async function rollbackPlan(ctx: PhaseContext): Promise<void> {
  const { journal, signal, emit } = ctx;
  const todo = [...ctx.records.values()].filter((r) => r.rollbackStage === 'restored'
    && r.rollbackMethod === 'version' && !r.rollbackNote && r.rollbackRepreview === undefined);
  if (todo.length === 0) return;
  for (const rec of todo.filter((r) => r.bucket !== 'update-and-publish')) {
    rec.rollbackRepreview = false;
    rec.rollbackRepublish = false;
    journal.put(rec);
  }
  const check = todo.filter((r) => r.bucket === 'update-and-publish');
  if (check.length === 0) return;
  const statuses = await bulkStatus(check.map((r) => r.path), signal, (d, t) => emit({ type: 'progress', label: 'Checking what was previewed / published', done: d, total: t }));
  for (const rec of check) {
    const st = statuses.get(rec.path);
    if (!st?.ok) {
      rec.rollbackError = 'Publish status unknown; run Roll back again';
    } else {
      const republish = st.publishLastModified !== undefined && st.publishLastModified > (rec.publishLastModified ?? 0);
      const repreview = republish || (st.previewLastModified !== undefined && st.previewLastModified > (rec.previewLastModified ?? 0));
      rec.rollbackRepublish = republish;
      rec.rollbackRepreview = repreview;
      rec.rollbackPreviewBaseline = st.previewLastModified;
      rec.rollbackPublishBaseline = st.publishLastModified;
      rec.rollbackError = undefined;
    }
    journal.put(rec);
  }
  emit({ type: 'changed' });
}

/** Rollback, step 3: re-preview restored pages whose preview changed after the scan. */
async function rollbackPreview(ctx: PhaseContext): Promise<void> {
  const { journal, signal, emit } = ctx;
  const candidates = [...ctx.records.values()].filter((r) => r.rollbackStage === 'restored'
    && r.rollbackRepreview !== undefined && rollbackNeedsPreview(r));
  if (candidates.length === 0) return;
  const todo = await unchangedSinceRollback(ctx, candidates, 'Edited after the rollback; not re-previewed or republished');
  const paths = todo.map((r) => r.path);
  emit({ type: 'log', level: 'info', msg: `Re-previewing ${todo.length} restored pages` });
  await bulkMutate('preview', paths, signal,
    (d, t) => emit({ type: 'progress', label: 'Re-previewing restored pages', done: d, total: t }),
    (msg) => emit({ type: 'log', level: 'warn', msg }));
  const statuses = await bulkStatus(paths, signal, (d, t) => emit({ type: 'progress', label: 'Confirming preview', done: d, total: t }));
  for (const rec of todo) {
    const st = statuses.get(rec.path);
    if (st?.ok && st.previewLastModified && st.previewLastModified > (rec.rollbackPreviewBaseline ?? 0)) {
      rec.rollbackStage = 'previewed';
      rec.rollbackPreviewLastModified = st.previewLastModified;
      rec.rollbackError = undefined;
    } else {
      rec.rollbackError = 'Rollback preview not confirmed; run Roll back again';
    }
    journal.put(rec);
  }
  emit({ type: 'changed' });
}

/** Rollback, step 4: re-publish restored pages whose publish changed after the scan, so the live site reverts. */
async function rollbackPublish(ctx: PhaseContext): Promise<void> {
  const { journal, signal, emit } = ctx;
  const candidates = [...ctx.records.values()].filter((r) => r.rollbackStage === 'previewed' && rollbackNeedsPublish(r));
  if (candidates.length === 0) return;
  const pre = await bulkStatus(candidates.map((r) => r.path), signal, (d, t) => emit({ type: 'progress', label: 'Re-checking before republish', done: d, total: t }));
  const ready: DocRecord[] = [];
  for (const rec of candidates) {
    const st = pre.get(rec.path);
    if (!st?.ok) {
      rec.rollbackError = 'Publish status unknown; run Roll back again';
      journal.put(rec);
    } else if (st.publishLastModified === undefined) {
      rollbackNote(ctx, rec, 'No longer live; source restored but not republished');
    } else if (st.previewLastModified !== rec.rollbackPreviewLastModified) {
      rollbackNote(ctx, rec, 'Previewed again by someone else after the rollback; not republished');
    } else {
      ready.push(rec);
    }
  }
  const todo = await unchangedSinceRollback(ctx, ready, 'Edited after the rollback; not republished');
  const paths = todo.map((r) => r.path);
  emit({ type: 'log', level: 'info', msg: `Re-publishing ${todo.length} restored pages` });
  await bulkMutate('live', paths, signal,
    (d, t) => emit({ type: 'progress', label: 'Re-publishing restored pages', done: d, total: t }),
    (msg) => emit({ type: 'log', level: 'warn', msg }));
  const post = await bulkStatus(paths, signal, (d, t) => emit({ type: 'progress', label: 'Confirming publish', done: d, total: t }));
  for (const rec of todo) {
    const st = post.get(rec.path);
    if (st?.ok && st.publishLastModified && st.publishLastModified > (rec.rollbackPublishBaseline ?? 0)) {
      rec.rollbackStage = 'published';
      rec.rollbackError = undefined;
    } else {
      rec.rollbackError = 'Rollback publish not confirmed; run Roll back again';
    }
    journal.put(rec);
  }
  emit({ type: 'changed' });
}

/**
 * Roll back everything this tool changed in the run: restore sources, then re-preview and
 * re-publish the pages it had previewed/published. Re-running continues where it stopped.
 */
export async function rollback(ctx: PhaseContext): Promise<void> {
  await rollbackSources(ctx);
  await rollbackPlan(ctx);
  await rollbackPreview(ctx);
  await rollbackPublish(ctx);
  const left = eligibleFor('rollback', ctx.records.values()).length;
  ctx.emit({ type: 'changed' });
  ctx.emit({
    type: 'log',
    level: left === 0 ? 'success' : 'warn',
    msg: left === 0 ? 'Rollback complete' : `Rollback finished with ${left} documents still to retry (see results)`,
  });
}
