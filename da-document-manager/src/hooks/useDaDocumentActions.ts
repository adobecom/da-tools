import type { Dispatch, SetStateAction } from 'react';
import {
  triggerPreview,
  triggerPublish,
  triggerUnpublish,
  deleteDocument,
  daPathToPreviewUrl,
  daPathToLiveUrl,
  bulkPreview,
  bulkPublish,
  bulkUnpublish,
  type BulkMutateOutcome,
} from '../api/daApi';
import { getToken } from '../da';
import { runBatch } from '../lib/concurrency';
import type { RowResult, RowStage } from '../types';

/** Which bulk operation is reporting progress (drives an n/m counter in the view). */
export type BulkProgressOp = 'previewing' | 'publishing' | 'unpublishing';

export interface DaDocumentActionsOptions<T extends RowResult> {
  /**
   * Called after a successful delete. Return the row's replacement state, or `undefined` to
   * remove the row from the list entirely (the document is just gone).
   */
  afterDelete: (row: T) => T | undefined;
  /** Progress for the job-based bulk preview/publish/unpublish, fed from the job's processed/total. */
  onBulkProgress?: (op: BulkProgressOp, done: number, total: number) => void;
}

export interface DaDocumentActions<T extends RowResult> {
  previewRow: (row: T) => Promise<void>;
  publishRow: (row: T) => Promise<void>;
  unpublishRow: (row: T) => Promise<void>;
  deleteRow: (row: T) => Promise<void>;
  previewBulk: (rows: T[]) => Promise<void>;
  publishBulk: (rows: T[]) => Promise<void>;
  unpublishBulk: (rows: T[]) => Promise<void>;
  deleteBulk: (rows: T[]) => Promise<void>;
}

export function useDaDocumentActions<T extends RowResult>(
  setResults: Dispatch<SetStateAction<T[]>>,
  options: DaDocumentActionsOptions<T>,
): DaDocumentActions<T> {
  function patch(id: string, changes: Partial<T>) {
    setResults((prev) => prev.map((r) => (r.id === id ? { ...r, ...changes } : r)));
  }

  function patchMany(ids: Set<string>, changes: Partial<T>) {
    setResults((prev) => prev.map((r) => (ids.has(r.id) ? { ...r, ...changes } : r)));
  }

  // ── Single-row actions (table pills) — per-path endpoints, unchanged ────────────────────────
  async function previewOne(row: T) {
    const token = getToken();
    if (!token) return;
    patch(row.id, { stage: 'previewing' } as Partial<T>);
    try {
      await triggerPreview(row.path, token);
      patch(row.id, { stage: 'previewed', previewUrl: daPathToPreviewUrl(row.path) } as Partial<T>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch(row.id, { stage: 'error', error: msg } as Partial<T>);
    }
  }

  async function publishOne(row: T) {
    const token = getToken();
    if (!token) return;
    patch(row.id, { stage: 'publishing' } as Partial<T>);
    try {
      await triggerPublish(row.path, token);
      patch(row.id, { stage: 'published', liveUrl: daPathToLiveUrl(row.path) } as Partial<T>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch(row.id, { stage: 'error', error: msg } as Partial<T>);
    }
  }

  async function unpublishOne(row: T) {
    const token = getToken();
    if (!token) return;
    patch(row.id, { stage: 'unpublishing' } as Partial<T>);
    try {
      await triggerUnpublish(row.path, token);
      patch(row.id, { stage: 'unpublished', liveUrl: undefined } as Partial<T>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch(row.id, { stage: 'error', error: msg } as Partial<T>);
    }
  }

  async function deleteOne(row: T) {
    const token = getToken();
    if (!token) return;
    patch(row.id, { stage: 'deleting' } as Partial<T>);
    try {
      await deleteDocument(row.path, token);
      const replacement = options.afterDelete(row);
      setResults((prev) =>
        replacement
          ? prev.map((r) => (r.id === row.id ? replacement : r))
          : prev.filter((r) => r.id !== row.id),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch(row.id, { stage: 'error', error: msg } as Partial<T>);
    }
  }

  // ── Bulk actions — one AEM job per ~500 paths, reconciled per-path ──────────────────────────
  // Mark rows in-flight, run the job (streaming progress), then resolve each row from the outcome.
  // Patch by row `id`; look up outcomes by `path`.
  async function runBulkStage(
    rows: T[],
    inFlight: RowStage,
    op: BulkProgressOp,
    bulkFn: (paths: string[], token: string, onProgress?: (done: number, total: number) => void) => Promise<BulkMutateOutcome>,
    onSuccess: (row: T) => Partial<T>,
    perRowFallback: (row: T) => Promise<void>,
  ): Promise<BulkMutateOutcome | undefined> {
    const token = getToken();
    if (!token || rows.length === 0) return undefined;
    const ids = new Set(rows.map((r) => r.id));
    patchMany(ids, { stage: inFlight, error: undefined } as Partial<T>);
    const paths = [...new Set(rows.map((r) => r.path))];
    try {
      const outcome = await bulkFn(paths, token, (done, total) => options.onBulkProgress?.(op, done, total));
      setResults((prev) => prev.map((r) => {
        if (!ids.has(r.id)) return r;
        if (outcome.succeeded.has(r.path)) return { ...r, ...onSuccess(r) };
        const reason = outcome.failed.get(r.path);
        return reason ? ({ ...r, stage: 'error', error: reason } as T) : r;
      }));
      return outcome;
    } catch {
      // Whole-op failure (token lost, unexpected throw) → per-row fan-out (full per-row UI).
      await runBatch(rows, perRowFallback);
      return undefined;
    }
  }

  async function previewBulk(rows: T[]) {
    await runBulkStage(
      rows, 'previewing', 'previewing', bulkPreview,
      (r) => ({ stage: 'previewed', previewUrl: daPathToPreviewUrl(r.path) } as Partial<T>),
      previewOne,
    );
  }

  async function publishBulk(rows: T[]) {
    await runBulkStage(
      rows, 'publishing', 'publishing', bulkPublish,
      (r) => ({ stage: 'published', liveUrl: daPathToLiveUrl(r.path) } as Partial<T>),
      publishOne,
    );
  }

  async function unpublishBulk(rows: T[]) {
    await runBulkStage(
      rows, 'unpublishing', 'unpublishing', bulkUnpublish,
      () => ({ stage: 'unpublished', liveUrl: undefined } as Partial<T>),
      unpublishOne,
    );
  }

  return {
    previewRow: previewOne,
    publishRow: publishOne,
    unpublishRow: unpublishOne,
    deleteRow: deleteOne,
    previewBulk,
    publishBulk,
    unpublishBulk,
    deleteBulk: (rows) => runBatch(rows, deleteOne),
  };
}
