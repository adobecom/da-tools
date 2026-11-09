import type { ClassifyOutcome } from './classify';
import type { PathStatus } from '../api/daApi';

/** Where the dry-run scan puts a document. Only the two `update-*` buckets are ever written. */
export type ScanBucket =
  | 'update-and-publish'
  | 'update-source-only'
  | 'skip-unpublished-changes'
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
}

export const UPDATE_BUCKETS: ReadonlySet<ScanBucket> = new Set(['update-and-publish', 'update-source-only']);

/**
 * Bucket for a document whose highlight row matched. A page that is live and has source or preview
 * activity after its last publish holds unpublished changes, which our publish would push live.
 */
export function bucketForMatch(status: PathStatus | undefined, daLastModified?: number): ScanBucket {
  if (!status?.ok) return 'skip-status-unknown';
  const published = status.publishLastModified;
  if (published === undefined) return 'update-source-only';
  const source = status.sourceLastModified ?? daLastModified ?? 0;
  const preview = status.previewLastModified ?? 0;
  if (source > published || preview > published) return 'skip-unpublished-changes';
  return 'update-and-publish';
}

/** Product type = first folder under the scan root (or the root's own name for top-level docs). */
export function productTypeFor(path: string, root: string): string {
  const rest = path.slice(root.length).split('/').filter(Boolean);
  if (rest.length > 1) return rest[0];
  return root.split('/').filter(Boolean).pop() ?? '';
}

/** One-word final result for a document, used by the results table and the report. */
export function resultFor(r: DocRecord): string {
  if (r.stage === 'skipped') return 'skipped';
  if (r.error) return `failed (${r.stage === 'scanned' ? 'update' : r.stage === 'updated' ? 'preview' : 'publish'})`;
  if (!UPDATE_BUCKETS.has(r.bucket)) return r.bucket;
  if (r.stage === 'updated' && r.bucket === 'update-source-only') return 'updated (source only)';
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
