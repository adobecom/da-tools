import {
  bulkMutate, bulkStatus, crawlDocs, createVersion, fetchLivePlain, readSource, writeSource,
} from '../api/daApi';
import { runPool } from '../lib/concurrency';
import { isAbortError } from '../lib/http';
import { classify } from './classify';
import type { JournalWriter } from './journal';
import {
  bucketForMatch, hashText, productTypeFor, UPDATE_BUCKETS, type DocRecord,
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

export function eligibleFor(phase: 'apply' | 'preview' | 'publish' | 'verify', records: Iterable<DocRecord>): DocRecord[] {
  const out: DocRecord[] = [];
  for (const r of records) {
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
 * Keeps only documents whose source is still exactly what we wrote. Anything an author changed after
 * our update is skipped so their unreviewed edit is never previewed or published by this tool.
 */
async function unchangedSinceWrite(ctx: PhaseContext, recs: DocRecord[]): Promise<DocRecord[]> {
  const { journal, signal, emit } = ctx;
  const ok: DocRecord[] = [];
  let done = 0;
  emit({ type: 'progress', label: 'Checking for edits since our update', done: 0, total: recs.length });
  await runPool(recs, async (rec) => {
    try {
      const h = hashText(await readSource(rec.path, signal));
      if (h === rec.writtenHash || h === rec.pendingHash) {
        ok.push(rec);
      } else {
        rec.stage = 'skipped';
        rec.skipReason = 'Edited by someone else after our update';
        emit({ type: 'log', level: 'warn', msg: `Skipped ${rec.path}: ${rec.skipReason}` });
        journal.put(rec);
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      rec.error = `Re-check failed (${errMsg(err)}); retry this step`;
      journal.put(rec);
    }
    done += 1;
    emit({ type: 'progress', label: 'Checking for edits since our update', done, total: recs.length });
  }, READ_CONCURRENCY, signal);
  throwIfAborted(signal);
  return ok;
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
