import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { scanDocs, recheckStatuses, loadBatchMetadata, type ScanPhase } from '../lib/documentManager';
import { checkDirectoryExists, daPathToLiveUrl, daPathToPreviewUrl, daPathToProdUrl } from '../api/daApi';
import type { CrawlError } from '../api/crawl';
import { useDaDocumentActions, type BulkProgressOp } from '../hooks/useDaDocumentActions';
import ConfirmModal from './ConfirmModal';
import DocumentManagerTable, { type SortField } from './DocumentManagerTable';
import { ExternalLinkIcon } from './StatusCells';
import type { DocRow } from '../types';

const ALL = 'all';
const NO_BATCH = '(no batch)';
// Pre-filled path + placeholder for the scan input; scanning stays manual (see rootPath below).
const DEFAULT_ROOT_PATH = '/adobecom/da-express-milo/drafts/maxn';
// Example paths shown in the info popover, each with a copy-to-clipboard button.
const EXAMPLE_PATHS = [
  '/adobecom/da-express-milo/express/print/business-card',
  '/adobecom/da-dc/acrobat/online',
  '/adobecom/da-bacom/ca',
];
type StatusKey = 'draft' | 'previewed' | 'published' | 'unknown';
type BulkConfirmOp = 'preview' | 'publish' | 'unpublish' | 'delete';
type UrlExportKind = 'document' | 'preview' | 'live' | 'prod';

/** Collapse a row's stage + statusUnknown flag to the four author-facing status buckets. */
function statusOf(d: DocRow): StatusKey {
  if (d.statusUnknown) return 'unknown';
  if (d.stage === 'published') return 'published';
  if (d.stage === 'previewed') return 'previewed';
  return 'draft';
}

/** A row's subDirectory (`/hoodie/red`, or `/` at root) as folder segments (root = []). */
function toSegs(subDirectory: string): string[] {
  return subDirectory === '/' ? [] : subDirectory.slice(1).split('/');
}

function ScanProgressBar({ progress }: { progress: { phase: ScanPhase; done: number; total: number } }) {
  const { phase, done, total } = progress;
  const label = phase === 'discovering'
    ? 'Discovering documents…'
    : `Checking status… ${done} / ${total}`;
  const pct = total > 0 ? Math.round((done / total) * 100) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>{label}</span>
        {pct !== null && <span className="tabular-nums">{pct}%</span>}
      </div>
      <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
        <div
          className={`h-full rounded-full bg-blue-500 ${pct === null ? 'w-1/3 animate-pulse' : 'transition-[width] duration-200'}`}
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}

/** An example path with a copy-to-clipboard button that briefly confirms the copy. */
function CopyablePath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable (insecure context / denied) — no-op */ }
  }
  return (
    <span className="font-mono text-gray-400">
      {path}
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? 'Copied' : 'Copy path to clipboard'}
        title={copied ? 'Copied' : 'Copy to clipboard'}
        className={`ml-1.5 inline-flex align-middle cursor-pointer transition-colors ${copied ? 'text-green-600' : 'text-gray-400 hover:text-gray-600'}`}
      >
        {copied ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </span>
  );
}

export default function DocumentManagerView() {
  const [rootPathInput, setRootPathInput] = useState(DEFAULT_ROOT_PATH);
  // Starts null so the scan is manual — kicked off by the Scan button via handleScan.
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [scanNonce, setScanNonce] = useState(0);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [crawlErrors, setCrawlErrors] = useState<CrawlError[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [subDirFilter, setSubDirFilter] = useState<string>(ALL);
  const [batchFilter, setBatchFilter] = useState<string>(ALL);
  const [batchDataState, setBatchDataState] = useState<'none' | 'loading' | 'loaded'>('none');
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const opIdRef = useRef(0); // cancel token shared by the manual async ops (status recheck + batch load)
  const [sortField, setSortField] = useState<SortField>('path');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [confirmOp, setConfirmOp] = useState<BulkConfirmOp | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ op: BulkProgressOp; done: number; total: number } | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  // Live, debounced validation of the directory input — drives the Valid/Invalid feedback card and
  // gates the Scan button. `loading` is intentionally NOT part of `anyBusy` (it fires on every
  // keystroke and must not lock the whole view while the user is still typing).
  const [dirCheck, setDirCheck] = useState<{ loading: boolean; valid: boolean; error: string | null }>({
    loading: false,
    valid: false,
    error: null,
  });
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showPathHints, setShowPathHints] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [scanProgress, setScanProgress] = useState<{ phase: ScanPhase; done: number; total: number } | null>(null);
  const scanning = scanProgress !== null;

  const actions = useDaDocumentActions<DocRow>(setDocs, {
    afterDelete: () => undefined,
    onBulkProgress: (op, done, total) => setBulkProgress({ op, done, total }),
  });

  // Strict single-operation lock: while any long op runs (scan, status recheck, batch load, or a
  // bulk action), every trigger is disabled so two operations can never overlap.
  const anyBusy = scanning || batchDataState === 'loading' || busy;

  // Live-validate the directory input (debounced) so the user gets Valid/Invalid feedback as they
  // type, mirroring the PDP/output-directory pattern. A format check runs first (no network call for
  // an obviously-malformed path); otherwise `checkDirectoryExists` confirms the folder exists. The
  // `cancelled` flag drops stale responses. Runs on mount too, validating the prefilled default.
  useEffect(() => {
    const trimmed = rootPathInput.trim();
    if (!trimmed) {
      setDirCheck({ loading: false, valid: false, error: null });
      return;
    }
    const segments = trimmed.split('/').filter(Boolean);
    if (!trimmed.startsWith('/') || segments.length < 2) {
      setDirCheck({ loading: false, valid: false, error: 'Enter a full DA path: /org/repo/optional/subpath' });
      return;
    }
    let cancelled = false;
    setDirCheck((d) => ({ ...d, loading: true, error: null }));
    const timer = setTimeout(async () => {
      const res = await checkDirectoryExists(trimmed);
      if (cancelled) return;
      setDirCheck({ loading: false, valid: res.valid, error: res.error ?? null });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [rootPathInput]);

  // Cancel any in-flight manual op (recheck / batch load) when the view unmounts (navigate away),
  // so its callbacks never fire on an unmounted component. The scan is cancelled by its own cleanup.
  useEffect(() => () => { opIdRef.current += 1; }, []);

  function handleScan() {
    // Validity is owned by the debounced effect above (which also gates the Scan button); scanning is
    // blocked unless the live check passed, so no re-check is needed here.
    if (anyBusy || !dirCheck.valid) return;
    setShowPathHints(false);
    setRootPath(rootPathInput.trim());
    setScanNonce((n) => n + 1);
  }

  // Run the segmented scan whenever the path changes or Rescan bumps scanNonce. A `stale` flag
  // (flipped in cleanup) makes a superseded or unmounted scan's callbacks no-ops.
  useEffect(() => {
    if (rootPath === null) return;
    // A new scan supersedes any in-flight manual op (recheck / batch load) and resets the sub-directory
    // + filters (the tree changed, so a stale prefix/batch could point at things that no longer exist).
    opIdRef.current += 1;
    setBatchDataState('none');
    setBatchFilter(ALL);
    setBatchProgress(null);
    setSubDirFilter(ALL);
    let stale = false;
    void scanDocs(rootPath, {
      onDiscovered: (placeholders) => {
        if (stale) return;
        setDocs(placeholders);
        setSelected(new Set());
        setDismissedErrors(false);
      },
      onStatuses: (updates) => {
        if (stale) return;
        const byPath = new Map(updates.map((u) => [u.path, u]));
        setDocs((prev) => prev.map((d) => {
          const u = byPath.get(d.path);
          // Prefer the last-modified from discovery; only backfill from the status job if absent.
          return u ? { ...d, ...u, lastUpdated: d.lastUpdated ?? u.lastUpdated } : d;
        }));
      },
      onProgress: (phase, done, total) => {
        if (stale) return;
        setScanProgress({ phase, done, total });
      },
      cancelled: () => stale,
    }).then(
      ({ errors }) => {
        if (stale) return;
        setCrawlErrors(errors);
        setHasScanned(true);
        setScanProgress(null);
      },
      (err: unknown) => {
        if (stale) return;
        setCrawlErrors([{ dirPath: rootPath, message: err instanceof Error ? err.message : String(err) }]);
        setHasScanned(true);
        setScanProgress(null);
      },
    );
    // Abort the in-flight scan when a rescan starts or the component unmounts.
    return () => { stale = true; };
  }, [rootPath, scanNonce]);

  // Re-resolve status for a set of already-listed rows — no re-crawl. Shared by "Recheck status"
  // (unknowns only) and "Refresh status" (all rows).
  async function runStatusCheck(paths: string[]) {
    if (anyBusy || paths.length === 0) return;
    const myId = (opIdRef.current += 1);
    setScanProgress({ phase: 'checking', done: 0, total: paths.length });
    try {
      await recheckStatuses(paths, {
        onStatuses: (updates) => {
          if (opIdRef.current !== myId) return;
          const byPath = new Map(updates.map((u) => [u.path, u]));
          setDocs((prev) => prev.map((d) => {
            const u = byPath.get(d.path);
            return u ? { ...d, ...u, lastUpdated: d.lastUpdated ?? u.lastUpdated } : d;
          }));
        },
        onProgress: (phase, done, total) => { if (opIdRef.current === myId) setScanProgress({ phase, done, total }); },
        cancelled: () => opIdRef.current !== myId,
      });
    } finally {
      if (opIdRef.current === myId) setScanProgress(null);
    }
  }

  function handleRecheckUnknowns() {
    void runStatusCheck(docs.filter((d) => d.statusUnknown).map((d) => d.path));
  }

  function handleRefreshStatus() {
    void runStatusCheck(docs.map((d) => d.path));
  }

  // Opt-in per-doc metadata pass — populates `generatedBatch` and enables the Batch filter. A
  // monotonic id makes a superseded (rescanned) load's callbacks no-ops.
  async function handleLoadBatchData() {
    if (anyBusy || docs.length === 0) return;
    const myId = (opIdRef.current += 1);
    setBatchDataState('loading');
    setBatchProgress({ done: 0, total: docs.length });
    await loadBatchMetadata(docs.map((d) => d.path), {
      onBatches: (updates) => {
        if (opIdRef.current !== myId) return;
        const byPath = new Map(updates.map((u) => [u.path, u]));
        setDocs((prev) => prev.map((d) => {
          const u = byPath.get(d.path);
          return u ? { ...d, generatedBatch: u.generatedBatch } : d;
        }));
      },
      onProgress: (done, total) => {
        if (opIdRef.current === myId) setBatchProgress({ done, total });
      },
      cancelled: () => opIdRef.current !== myId,
    });
    if (opIdRef.current !== myId) return;
    setBatchDataState('loaded');
    setBatchProgress(null);
  }

  // Every distinct sub-directory (folder prefix) across all docs, with a descendant-inclusive doc
  // count — derived from ALL docs (not `filtered`) so status/batch filters never distort the tree.
  // Each folder counts docs directly in it AND in any nested folder, matching the counts shown by
  // the drill-down pills this dropdown replaced.
  const subDirOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of docs) {
      const segs = toSegs(d.subDirectory);
      // Tally this doc against its own folder and every ancestor folder (prefix-inclusive).
      for (let i = 1; i <= segs.length; i++) {
        const path = `/${segs.slice(0, i).join('/')}`;
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [docs]);

  // Distinct batch values (newest ISO first), with a "(no batch)" bucket last.
  const batches = useMemo(
    () => [...new Set(docs.map((d) => d.generatedBatch || NO_BATCH))]
      .sort((a, b) => (a === NO_BATCH ? 1 : b === NO_BATCH ? -1 : b.localeCompare(a))),
    [docs],
  );

  const filtered = useMemo(() => {
    return docs.filter((d) => {
      // Sub-directory filter is prefix-inclusive: the folder itself and everything nested under it.
      if (subDirFilter !== ALL && !(d.subDirectory === subDirFilter || d.subDirectory.startsWith(`${subDirFilter}/`))) return false;
      if (statusFilter !== ALL && statusOf(d) !== statusFilter) return false;
      if (batchFilter !== ALL && (d.generatedBatch || NO_BATCH) !== batchFilter) return false;
      return true;
    });
  }, [docs, subDirFilter, statusFilter, batchFilter]);

  const sorted = useMemo(() => {
    const value = (d: DocRow): string => {
      switch (sortField) {
        case 'path': return d.path;
        case 'lastUpdated': return String(d.lastUpdated ?? '');
        case 'status': return statusOf(d);
        default: return '';
      }
    };
    const copy = [...filtered];
    copy.sort((a, b) => {
      const cmp = value(a).localeCompare(value(b));
      return sortDirection === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortField, sortDirection]);

  // Close the Export menu on any outside click.
  useEffect(() => {
    if (!showExportMenu) return;
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showExportMenu]);

  // URLs are derived from each visible (sorted) doc's path + resolved stage.
  function collectUrls(kind: UrlExportKind): string[] {
    switch (kind) {
      case 'document':
        return sorted.map((d) => `https://da.live/edit#${d.path}`);
      case 'preview':
        return sorted
          .filter((d) => d.previewUrl || d.stage === 'previewed' || d.stage === 'published')
          .map((d) => daPathToPreviewUrl(d.path));
      case 'live':
        return sorted
          .filter((d) => d.liveUrl || d.stage === 'published')
          .map((d) => daPathToLiveUrl(d.path));
      case 'prod':
        return sorted
          .filter((d) => d.liveUrl || d.stage === 'published')
          .map((d) => daPathToProdUrl(d.path));
    }
  }

  function handleExportUrls(kind: UrlExportKind) {
    setShowExportMenu(false);
    const urls = collectUrls(kind);
    if (urls.length === 0) return; // options with 0 are disabled; this is a guard
    const label = { document: 'document', preview: 'preview', live: 'published-aem', prod: 'published-adobe' }[kind];
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([`${urls.join('\n')}\n`], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${label}-urls-${date}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function toggleSelectAll() {
    const allSelected = sorted.length > 0 && sorted.every((d) => selected.has(d.path));
    setSelected(allSelected ? new Set() : new Set(sorted.map((d) => d.path)));
  }

  const selectedDocs = docs.filter((d) => selected.has(d.path));

  // Keep the selection in sync with the doc list: drop any selected path that no longer exists
  // (e.g. after a bulk delete) so the "N selected" count and select-all state stay correct.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(docs.map((d) => d.path));
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (valid.has(p)) next.add(p);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [docs]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      setBulkProgress(null);
      // Selections persist across bulk ops so users can chain workflows (preview → publish →
      // unpublish/delete) on the same batch. Deleted rows are pruned by the reconcile effect below.
    }
  }

  const unknownCount = hasScanned && !scanning ? docs.filter((d) => d.statusUnknown).length : 0;
  const anyFilterActive = statusFilter !== ALL || batchFilter !== ALL || subDirFilter !== ALL;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        {/* Label + info icon (the icon sits next to the label). */}
        <div className="flex items-center gap-1.5">
          <label htmlFor="dm-root-path" className="text-xs font-medium text-gray-600">Directory to scan</label>
          <button
            type="button"
            onClick={() => setShowPathHints((p) => !p)}
            aria-label="Show example paths"
            aria-expanded={showPathHints}
            title="Show example paths"
            className={`inline-flex items-center shrink-0 cursor-pointer transition-colors ${showPathHints ? 'text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 block">
              <path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm8.706-1.442c1.146-.573 2.437.463 2.126 1.706l-.709 2.836.042-.02a.75.75 0 0 1 .67 1.342l-.04.022c-1.147.573-2.438-.463-2.127-1.706l.71-2.836-.042.02a.75.75 0 1 1-.671-1.34l.041-.022ZM12 9a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {/* Example paths shown underneath the label when toggled, each with a copy-to-clipboard button. */}
        {showPathHints && (
          <div className="flex flex-col gap-0.5 text-xs text-gray-500">
            <span>Examples:</span>
            {EXAMPLE_PATHS.map((p) => <CopyablePath key={p} path={p} />)}
          </div>
        )}

        {/* Directory input, prefixed with the fixed da.live URL so the field completes a full URL. */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-stretch flex-1 min-w-[280px] h-9 rounded-lg border border-gray-300 bg-white overflow-hidden focus-within:border-blue-400">
            <span className="flex items-center shrink-0 select-none border-r border-gray-300 bg-gray-50 px-2 text-xs font-mono text-gray-400">
              https://da.live/#
            </span>
            <input
              id="dm-root-path"
              type="text"
              value={rootPathInput}
              onChange={(e) => setRootPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleScan(); }}
              placeholder={DEFAULT_ROOT_PATH}
              className="flex-1 min-w-0 px-3 text-sm font-mono bg-transparent focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleScan()}
            disabled={anyBusy || dirCheck.loading || !dirCheck.valid}
            className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {scanning ? 'Scanning…' : rootPath === rootPathInput.trim() && hasScanned ? 'Rescan' : 'Scan'}
          </button>
          {hasScanned && !scanning && docs.length > 0 && (
            <button
              type="button"
              onClick={handleRefreshStatus}
              disabled={anyBusy}
              className="px-4 py-2 bg-white text-gray-700 text-sm font-medium rounded-xl border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              Refresh status
            </button>
          )}
          {hasScanned && !scanning && (
            <span className="text-sm text-gray-500">{docs.length} document{docs.length !== 1 ? 's' : ''} found</span>
          )}
        </div>

        {/* Live directory-validation feedback (debounced) — shows the full absolute da.live URL. */}
        {dirCheck.loading && <p className="text-xs text-gray-400">Validating…</p>}
        {!dirCheck.loading && (dirCheck.valid || dirCheck.error) && (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                dirCheck.valid ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              }`}
            >
              {dirCheck.valid ? 'Valid' : 'Invalid'}
            </span>
            {dirCheck.valid ? (
              <a
                href={`https://da.live/#${rootPathInput.trim()}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 break-all font-mono text-xs text-gray-500 hover:text-blue-600"
              >
                {`https://da.live/#${rootPathInput.trim()}`}
                <ExternalLinkIcon />
              </a>
            ) : (
              <span className="text-xs text-red-600">{dirCheck.error}</span>
            )}
          </div>
        )}
      </div>

      {scanning && scanProgress && <ScanProgressBar progress={scanProgress} />}

      {busy && bulkProgress && (
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <span className="tabular-nums">
            {bulkProgress.op === 'previewing' ? 'Previewing' : bulkProgress.op === 'publishing' ? 'Publishing' : 'Unpublishing'}… {bulkProgress.done} / {bulkProgress.total}
          </span>
        </div>
      )}

      {crawlErrors.length > 0 && !dismissedErrors && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          <p className="flex-1">
            {crawlErrors.length} path{crawlErrors.length !== 1 ? 's' : ''} could not be read and may be missing from this list.
          </p>
          <button type="button" onClick={() => setDismissedErrors(true)} className="text-amber-700 hover:text-amber-900 font-medium cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {unknownCount > 0 && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          <p className="flex-1">
            Publish status couldn&apos;t be determined for {unknownCount} document{unknownCount !== 1 ? 's' : ''}; those rows show <strong>Unknown</strong> until rechecked.
          </p>
          <button
            type="button"
            onClick={handleRecheckUnknowns}
            disabled={anyBusy}
            className="font-medium text-amber-800 underline hover:text-amber-900 disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
          >
            Recheck status
          </button>
        </div>
      )}

      {(docs.length > 0 || hasScanned) && (
        <>
          <div className="flex items-center gap-3 flex-wrap text-sm">
            {subDirOptions.length > 0 && (
              <label className="flex items-center gap-1.5 text-gray-600">
                Sub-directory
                <select
                  value={subDirFilter}
                  onChange={(e) => setSubDirFilter(e.target.value)}
                  className="h-8 px-2 border border-gray-300 rounded-lg text-sm max-w-[240px]"
                >
                  <option value={ALL}>All</option>
                  {subDirOptions.map((o) => (
                    <option key={o.path} value={o.path}>{o.path} ({o.count})</option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-1.5 text-gray-600">
              Status
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-8 px-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value={ALL}>All</option>
                <option value="draft">Draft</option>
                <option value="previewed">Previewed</option>
                <option value="published">Published</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>

            {batchDataState === 'none' && docs.length > 0 && (
              <button
                type="button"
                onClick={() => void handleLoadBatchData()}
                disabled={anyBusy}
                className="px-3 py-1.5 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                Load batch data
              </button>
            )}
            {batchDataState === 'loading' && batchProgress && (
              <span className="text-gray-500 tabular-nums">
                Loading batch data… {batchProgress.done} / {batchProgress.total}
              </span>
            )}
            {batchDataState === 'loaded' && (
              <label className="flex items-center gap-1.5 text-gray-600">
                Batch
                <select
                  value={batchFilter}
                  onChange={(e) => setBatchFilter(e.target.value)}
                  className="h-8 px-2 border border-gray-300 rounded-lg text-sm"
                >
                  <option value={ALL}>All</option>
                  {batches.map((b) => (
                    <option key={b} value={b}>{b === NO_BATCH ? b : new Date(b).toLocaleDateString()}</option>
                  ))}
                </select>
              </label>
            )}

            {anyFilterActive && (
              <span className="text-gray-500">{filtered.length} shown</span>
            )}

            <div ref={exportMenuRef} className="relative ml-auto">
              <button
                type="button"
                onClick={() => setShowExportMenu((p) => !p)}
                className="text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 cursor-pointer transition-colors flex items-center gap-1.5"
              >
                Export URLs
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-gray-400">
                  <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                </svg>
              </button>
              {showExportMenu && (() => {
                const opts: { kind: UrlExportKind; label: string }[] = [
                  { kind: 'document', label: 'Document links' },
                  { kind: 'preview', label: 'Preview links (.aem.page)' },
                  { kind: 'live', label: 'Published (.aem.live)' },
                  { kind: 'prod', label: 'Published (adobe.com)' },
                ];
                return (
                  <div className="absolute right-0 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg z-20 overflow-hidden">
                    {opts.map(({ kind, label }, i) => {
                      const count = collectUrls(kind).length;
                      return (
                        <Fragment key={kind}>
                          {i > 0 && <div className="border-t border-gray-100" />}
                          <button
                            type="button"
                            disabled={count === 0}
                            onClick={() => handleExportUrls(kind)}
                            className="w-full text-left px-4 py-2.5 text-sm flex items-center justify-between text-gray-700 hover:bg-gray-50 cursor-pointer disabled:text-gray-300 disabled:hover:bg-white disabled:cursor-not-allowed"
                          >
                            <span>{label}</span>
                            <span className="text-gray-400">{count}</span>
                          </button>
                        </Fragment>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>

          {docs.length > 0 && (() => {
            const baseDisabled = anyBusy || selectedDocs.length === 0;
            const allPublished = selectedDocs.length > 0 && selectedDocs.every((d) => statusOf(d) === 'published');
            return (
              <div className="flex items-center gap-2 flex-wrap text-sm bg-gray-50 border border-gray-200 rounded-xl px-4 py-2">
                <span className="font-medium text-gray-700">{selectedDocs.length} selected</span>
                <BulkButton label="Preview" onClick={() => setConfirmOp('preview')} disabled={baseDisabled} className="text-indigo-700 hover:bg-indigo-50 border-indigo-200" />
                <BulkButton label="Publish" onClick={() => setConfirmOp('publish')} disabled={baseDisabled} className="text-green-700 hover:bg-green-50 border-green-200" />
                <BulkButton label="Unpublish" onClick={() => setConfirmOp('unpublish')} disabled={baseDisabled || !allPublished} className="text-red-700 hover:bg-red-50 border-red-200" />
                <BulkButton label="Delete" onClick={() => setConfirmOp('delete')} disabled={baseDisabled} className="text-red-700 hover:bg-red-50 border-red-200" />
              </div>
            );
          })()}

          <DocumentManagerTable
            rows={sorted}
            selected={selected}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            allSelected={sorted.length > 0 && sorted.every((d) => selected.has(d.path))}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            actions={actions}
          />
        </>
      )}

      {confirmOp && (() => {
        const cfg = {
          preview: { verb: 'Preview', className: 'bg-indigo-600 hover:bg-indigo-700', run: () => actions.previewBulk(selectedDocs), body: 'This will (re)generate an aem.page preview for the following documents:' },
          publish: { verb: 'Publish', className: 'bg-green-600 hover:bg-green-700', run: () => actions.publishBulk(selectedDocs), body: 'This will publish the following documents to production:' },
          unpublish: { verb: 'Unpublish', className: 'bg-red-600 hover:bg-red-700', run: () => actions.unpublishBulk(selectedDocs), body: 'This will unpublish (remove from production) the following documents:' },
          delete: { verb: 'Delete', className: 'bg-red-700 hover:bg-red-800', run: () => actions.deleteBulk(selectedDocs), body: 'This will permanently delete the following documents from DA:' },
        }[confirmOp];
        return (
          <ConfirmModal
            title={`${cfg.verb} ${selectedDocs.length} document${selectedDocs.length !== 1 ? 's' : ''}?`}
            confirmLabel={cfg.verb}
            confirmClassName={`px-4 py-2 ${cfg.className} text-white text-sm font-medium rounded-xl cursor-pointer transition-colors`}
            onCancel={() => setConfirmOp(null)}
            onConfirm={() => { const run = cfg.run; setConfirmOp(null); void withBusy(run); }}
          >
            <p className="text-sm text-gray-500">{cfg.body}</p>
            <ul className="text-xs font-mono text-gray-700 max-h-64 overflow-y-auto border border-gray-100 rounded-lg p-3 flex flex-col gap-1">
              {selectedDocs.map((d) => <li key={d.path} className="whitespace-nowrap">{d.path}</li>)}
            </ul>
          </ConfirmModal>
        );
      })()}
    </div>
  );
}

function BulkButton({
  label,
  onClick,
  disabled,
  className,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  className: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 bg-white text-xs font-medium rounded-lg border disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors ${className}`}
    >
      {label}
    </button>
  );
}
