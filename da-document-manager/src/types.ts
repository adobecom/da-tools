// Generic row model for the DA Document Manager. Deliberately product-agnostic: a row is just a
// path + lifecycle stage (+ the optional urls/timestamps the scan and actions fill in). This is the
// abstract counterpart to pdp-document-generator's product-specific `ManagedDoc` — no product id,
// batch, title/description, or GMC state here.

export type RowStage =
  | 'draft' // exists in DA source only (not previewed/published)
  | 'previewing'
  | 'previewed'
  | 'publishing'
  | 'published'
  | 'unpublishing'
  | 'unpublished'
  | 'deleting'
  | 'error';

/** The minimal shape the lifecycle-action hook (useDaDocumentActions) is generic over. */
export interface RowResult {
  id: string;
  path: string;
  stage: RowStage;
  error?: string;
  previewUrl?: string;
  liveUrl?: string;
}

/** A document row in the manager table: a RowResult plus spine metadata + optional batch. */
export interface DocRow extends RowResult {
  /** Folder containing this doc, relative to the scanned root (e.g. `/hoodie/red`, or `/` at root).
   *  Path-derived at discovery — cheap spine metadata, drives the sub-directory drill-down. */
  subDirectory: string;
  /** Last-modified from the `/list` discovery, backfilled from the status job when absent. */
  lastUpdated?: string | number;
  /** True when the status check failed (rate-limited/unreachable) — render "Unknown", not "Draft". */
  statusUnknown?: boolean;
  /** `generated-batch` metadata (pdp-stamped ISO per bulk run). Populated only by the opt-in
   *  batch-load pass (a per-doc source fetch); `undefined` = not loaded / no batch. */
  generatedBatch?: string;
}
