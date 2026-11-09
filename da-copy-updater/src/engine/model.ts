import type { ClassifyOutcome } from './classify';
import type { PathStatus } from '../api/daApi';

/**
 * Where the dry-run scan puts a document. Only `update-*` buckets are written, and only
 * `update-and-publish` is ever previewed or published.
 */
export type ScanBucket =
  | 'update-and-publish'
  | 'update-source-only'
  | 'update-unpublished-changes'
  | 'skip-status-unknown'
  | Exclude<ClassifyOutcome, 'match'>
  | 'scan-error';

/** How far a document has progressed after the scan. */
export type Stage = 'scanned' | 'updated' | 'previewed' | 'published' | 'skipped';

export interface DocRecord {
  path: string;
  productType: string;
  bucket: ScanBucket;
  detail?: string;
  /** Hash of the source at scan time, to detect edits between Scan and Apply. */
  hash?: string;
  /** Hash of the HTML we are about to write; lets a retry recognize a write that already landed. */
  pendingHash?: string;
  /** Hash of the source as read back after our write; later steps require it to be unchanged. */
  writtenHash?: string;
  daLastModified?: number;
  sourceLastModified?: number;
  previewLastModified?: number;
  publishLastModified?: number;
  stage: Stage;
  /** Why a document was skipped after the scan. */
  skipReason?: string;
  /** Last error for the current stage; the doc keeps its stage so the step can be retried. */
  error?: string;
  /** previewLastModified confirmed after our preview, used to detect later re-previews. */
  ourPreviewLastModified?: number;
  liveVerified?: boolean;
  /** Rollback progress: source restored, then (only where we had previewed/published) re-previewed/re-published. */
  rollbackStage?: 'restored' | 'previewed' | 'published';
  /** `version` = saved version restored; `reverted-copy` = only our heading reverted; `already-original` = nothing to do. */
  rollbackMethod?: 'version' | 'reverted-copy' | 'already-original';
  /** Hash of the HTML a rollback is about to write (recognizes an interrupted rollback write). */
  rollbackPendingHash?: string;
  /** Hash of the source after the rollback write. */
  rollbackHash?: string;
  rollbackPreviewLastModified?: number;
  /**
   * Whether rollback must re-preview / re-publish, decided from live status after the restore (so a
   * forward preview/publish that ran but was never confirmed is still reverted). Undefined = not yet decided.
   */
  rollbackRepreview?: boolean;
  rollbackRepublish?: boolean;
  rollbackPreviewBaseline?: number;
  rollbackPublishBaseline?: number;
  /** Why a rollback stopped at the source (no re-preview / re-publish). */
  rollbackNote?: string;
  rollbackError?: string;
}

export const UPDATE_BUCKETS: ReadonlySet<ScanBucket> = new Set([
  'update-and-publish',
  'update-source-only',
  'update-unpublished-changes',
]);

/**
 * Bucket for a document whose highlight row matched. A page that is live and has source or preview
 * activity after its last publish holds unpublished changes: it gets the edit, but publishing it
 * would push the author's pending changes live, so it is never previewed or published.
 */
export function bucketForMatch(status: PathStatus | undefined, daLastModified?: number): ScanBucket {
  if (!status?.ok) return 'skip-status-unknown';
  const published = status.publishLastModified;
  if (published === undefined) return 'update-source-only';
  const source = status.sourceLastModified ?? daLastModified ?? 0;
  const preview = status.previewLastModified ?? 0;
  if (source > published || preview > published) return 'update-unpublished-changes';
  return 'update-and-publish';
}

/** Product type = first folder under the scan root (or the root's own name for top-level docs). */
export function productTypeFor(path: string, root: string): string {
  const rest = path.slice(root.length).split('/').filter(Boolean);
  if (rest.length > 1) return rest[0];
  return root.split('/').filter(Boolean).pop() ?? '';
}

/** True once this tool has written (or may have written) the document. */
export function wroteDoc(r: DocRecord): boolean {
  return r.writtenHash !== undefined || r.pendingHash !== undefined;
}

export function inRollback(r: DocRecord): boolean {
  return r.rollbackStage !== undefined || r.rollbackError !== undefined;
}

/**
 * Rollback re-previews / re-publishes only pages whose saved version was restored as-is, that were
 * live-and-clean at scan time, and whose preview / publish moved after the scan (decided by the
 * rollback planning step; assumed possible until then).
 */
export function rollbackNeedsPreview(r: DocRecord): boolean {
  if (r.rollbackMethod !== 'version' || r.rollbackNote) return false;
  return r.rollbackRepreview ?? r.bucket === 'update-and-publish';
}

export function rollbackNeedsPublish(r: DocRecord): boolean {
  if (r.rollbackMethod !== 'version' || r.rollbackNote) return false;
  return r.rollbackRepublish ?? r.bucket === 'update-and-publish';
}

/** Short result label for a document, used by the results table and the report. */
export function resultFor(r: DocRecord): string {
  if (inRollback(r)) {
    if (r.rollbackError) return 'rollback failed';
    if (r.rollbackStage === 'restored' && rollbackNeedsPreview(r)) return 'rolling back, pending preview';
    if (r.rollbackStage === 'previewed' && rollbackNeedsPublish(r)) return 'rolling back, pending publish';
    return r.rollbackNote ? 'rolled back (source only)' : 'rolled back';
  }
  if (r.stage === 'skipped') return 'skipped';
  if (r.error) return `failed (${r.stage === 'scanned' ? 'update' : r.stage === 'updated' ? 'preview' : 'publish'})`;
  if (!UPDATE_BUCKETS.has(r.bucket)) return r.bucket;
  if (r.stage === 'updated' && r.bucket === 'update-source-only') return 'updated (not live)';
  if (r.stage === 'updated' && r.bucket === 'update-unpublished-changes') return 'updated (not published: had unpublished changes)';
  if (r.stage === 'scanned') return 'pending update';
  if (r.stage === 'updated') return 'updated, pending preview';
  if (r.stage === 'previewed') return 'previewed, pending publish';
  return r.liveVerified === false ? 'published (live check failed)' : 'published';
}

/** Small, fast, non-cryptographic hash (FNV-1a) used to detect source changes. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}-${s.length}`;
}
