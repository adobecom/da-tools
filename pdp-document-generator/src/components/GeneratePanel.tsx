import { useState, useEffect, useRef, Fragment } from 'react';
import { postDoc, createDocVersion, cat, docExists, listDirDocPaths, daPathToProdUrl } from '../api/daApi';
import { applyTemplate, rowToOutputPath, runGenerationQa, finalizeGeneratedDoc } from '../lib/generate';
import { runBatch, DEFAULT_CONCURRENCY, EXISTENCE_CHECK_CONCURRENCY, GENERATE_CONCURRENCY } from '../lib/concurrency';
import { useDaDocumentActions, type BulkProgressOp, type PublishQaConfig } from '../hooks/useDaDocumentActions';
import ConfirmModal from './ConfirmModal';
import {
  GeneratePill,
  PreviewPill,
  PublishPill,
  QaIssueBadge,
  ExternalLinkIcon,
  ExistenceBadge,
  ExistenceOutcomeBadge,
  type ExistenceCheck,
} from './StatusPills';
import type { CsvRow, ProductTypeConfig, RowResult, RowStage } from '../types';
import { isConfigWithinSite, isPathWithinSite, type SiteConfig } from '../sites';

interface Props {
  site: SiteConfig;
  rows: CsvRow[];
  productTypeConfigs: ProductTypeConfig[];
  overrideConfig?: ProductTypeConfig;
  generateBlockReason?: string;
  onResultsChange?: (hasResults: boolean) => void;
}

// Stages at which the source document exists in DA (i.e. a document link is valid).
const DOC_EXISTS_STAGES: ReadonlySet<RowStage> = new Set<RowStage>([
  'generated', 'previewing', 'previewed', 'publishing', 'published', 'unpublishing', 'unpublished',
]);

type BulkOp = 'idle' | 'generating' | 'previewing' | 'publishing' | 'unpublishing' | 'deleting';

type UrlExportKind = 'document' | 'preview' | 'live' | 'prod';

export default function GeneratePanel({ site, rows, productTypeConfigs, overrideConfig, generateBlockReason, onResultsChange }: Props) {
  const [results, setResults] = useState<RowResult[]>([]);
  const [bulkOp, setBulkOp] = useState<BulkOp>('idle');
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [existenceStatus, setExistenceStatus] = useState<Record<string, ExistenceCheck>>({});
  const checkedPaths = useRef<Set<string>>(new Set());
  const dirListCache = useRef<Map<string, Set<string>>>(new Map());
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [bulkProgress, setBulkProgress] = useState<{ op: BulkProgressOp; done: number; total: number } | null>(null);
  const [publishQaMode, setPublishQaMode] = useState<PublishQaConfig>({ mode: 'off' });
  const [generateConcurrency, setGenerateConcurrency] = useState(GENERATE_CONCURRENCY);

  const actions = useDaDocumentActions<RowResult>(setResults, {
    afterDelete: (r) => ({ id: r.id, path: r.path, stage: 'pending' }),
    onBulkProgress: (op, done, total) => setBulkProgress({ op, done, total }),
    publishQaConfig: publishQaMode,
  });

  const previewRows = results.length === 0
    ? rows.map((row) => {
        const cfg = resolveConfig(row.product_type ?? '');
        const path = cfg ? resolveOutputPath(row, cfg) : undefined;
        return {
          id: row['_id'],
          path: path ?? '',
          productType: row.product_type ?? '',
          hasConfig: !!path,
        };
      })
    : [];

  useEffect(() => {
    onResultsChange?.(results.some((r) => r.stage !== 'pending'));
  }, [results]);

  useEffect(() => {
    if (results.length > 0) return;
    const toCheck = previewRows.filter(
      (pr) => pr.hasConfig && pr.path && !checkedPaths.current.has(pr.path),
    );
    if (toCheck.length === 0) return;
    // Claim every candidate synchronously, before any await, so the re-render this setState
    // triggers filters them back out and the effect doesn't re-enter for the same paths.
    toCheck.forEach((pr) => checkedPaths.current.add(pr.path));
    setExistenceStatus((prev) => {
      const next = { ...prev };
      for (const pr of toCheck) next[pr.path] = 'checking';
      return next;
    });

    // Group candidates by the directory that would list them — the path prefix a listed file
    // shares. Deriving this from the candidate path (not the config outputDir) also correctly
    // handles a url_slug that itself contains a '/'.
    const byDir = new Map<string, string[]>();
    for (const pr of toCheck) {
      const dir = pr.path.slice(0, pr.path.lastIndexOf('/'));
      const bucket = byDir.get(dir);
      if (bucket) bucket.push(pr.path);
      else byDir.set(dir, [pr.path]);
    }

    const resolveFromSet = (paths: string[], existing: Set<string>) =>
      setExistenceStatus((prev) => {
        const next = { ...prev };
        for (const p of paths) next[p] = existing.has(p) ? 'exists' : 'not-found';
        return next;
      });

    // Fallback for a directory whose listing failed: probe each candidate directly. Raised
    // concurrency (DA source tolerates it); each probe self-throttles via fetchWithRetry.
    const headFallback = (paths: string[]) =>
      runBatch(paths, async (p) => {
        try {
          const exists = await docExists(p);
          setExistenceStatus((prev) => ({ ...prev, [p]: exists ? 'exists' : 'not-found' }));
        } catch {
          setExistenceStatus((prev) => ({ ...prev, [p]: 'error' }));
        }
      }, EXISTENCE_CHECK_CONCURRENCY);

    // Primary path: one directory listing resolves every candidate in that directory from an
    // in-memory set, replacing one HEAD per document. Listings are memoized per directory for the
    // session; a listing that throws routes just that directory's candidates to the HEAD fallback.
    void runBatch([...byDir.entries()], async ([dir, paths]) => {
      const cached = dirListCache.current.get(dir);
      if (cached) {
        resolveFromSet(paths, cached);
        return;
      }
      try {
        const existing = await listDirDocPaths(dir);
        dirListCache.current.set(dir, existing); // cache only after a fully successful listing
        resolveFromSet(paths, existing);
      } catch {
        await headFallback(paths);
      }
    }, DEFAULT_CONCURRENCY);
  }, [previewRows, results.length]);

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

  function toggleRowDetail(id: string) {
    setExpandedRowId((prev) => (prev === id ? null : id));
  }

  function collectUrls(kind: UrlExportKind): string[] {
    switch (kind) {
      case 'document':
        return results
          .filter((r) => r.editUrl || DOC_EXISTS_STAGES.has(r.stage))
          .map((r) => r.editUrl ?? `https://da.live/edit#${r.path}`);
      case 'preview':
        return results.filter((r) => r.previewUrl).map((r) => r.previewUrl!);
      case 'live':
        return results.filter((r) => r.liveUrl).map((r) => r.liveUrl!);
      case 'prod':
        return results.filter((r) => r.liveUrl).map((r) => daPathToProdUrl(r.path));
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

  function lookupConfig(productType: string): ProductTypeConfig | undefined {
    return productTypeConfigs.find((c) => c.productType === productType?.trim());
  }

  function resolveConfig(productType: string): ProductTypeConfig | undefined {
    const config = overrideConfig ?? lookupConfig(productType);
    return config && isConfigWithinSite(config, site) ? config : undefined;
  }

  function resolveOutputPath(row: CsvRow, config: ProductTypeConfig): string | undefined {
    const path = rowToOutputPath(row, config.outputDir);
    return isPathWithinSite(path, site) ? path : undefined;
  }

  // Existing-document handling: a row whose output path already exists in DA is
  // excluded from the Generate set by default. The "include duplicates" checkbox
  // opts them back in (they overwrite the existing doc, with a version backup).
  const rowOutputPath = (row: CsvRow) => {
    const cfg = resolveConfig(row.product_type ?? '');
    return cfg ? resolveOutputPath(row, cfg) ?? '' : '';
  };
  const rowAlreadyExists = (row: CsvRow) => existenceStatus[rowOutputPath(row)] === 'exists';
  const existingCount = rows.filter(rowAlreadyExists).length;
  const rowsToGenerate = includeDuplicates ? rows : rows.filter((r) => !rowAlreadyExists(r));
  const activePreview = previewRows.filter((pr) => includeDuplicates || existenceStatus[pr.path] !== 'exists');
  const excludedPreview = includeDuplicates ? [] : previewRows.filter((pr) => existenceStatus[pr.path] === 'exists');
  const allExistingBlockReason = !generateBlockReason && rows.length > 0 && rowsToGenerate.length === 0
    ? 'All selected documents already exist — enable “include duplicates” to overwrite them'
    : undefined;
  const effectiveBlockReason = generateBlockReason ?? allExistingBlockReason;

  const running = bulkOp !== 'idle';

  const counts = {
    generated: results.filter((r) =>
      ['generated', 'previewing', 'previewed', 'qa-fail', 'publishing', 'published'].includes(r.stage),
    ).length,
    previewable: results.filter((r) => r.stage === 'generated').length,
    previewed: results.filter((r) =>
      ['previewed', 'publishing', 'published'].includes(r.stage),
    ).length,
    publishable: results.filter((r) => r.stage === 'previewed').length,
    done: results.filter((r) => r.stage === 'generated').length,
    error: results.filter((r) => r.stage === 'error').length,
    published: results.filter((r) => r.stage === 'published').length,
    unpublished: results.filter((r) => r.stage === 'unpublished').length,
    deletable: results.filter((r) =>
      ['generated', 'qa-fail', 'previewing', 'previewed', 'publishing',
        'published', 'unpublishing', 'unpublished'].includes(r.stage),
    ).length,
  };

  async function handleGenerate() {
    const existenceSnapshot = { ...existenceStatus };
    setResults(
      rowsToGenerate.map((row) => {
        const cfg = resolveConfig(row.product_type ?? '');
        return { id: row['_id'], path: cfg ? resolveOutputPath(row, cfg) ?? '' : '', stage: 'pending' };
      }),
    );
    setBulkOp('generating');

    const generatedBatch = new Date().toISOString();
    const templateCache = new Map<string, string>();
    const queue = [...rowsToGenerate];
    let idx = 0;

    async function processRow(row: CsvRow) {
      const cfg = resolveConfig(row.product_type ?? '');
      if (!cfg) {
        setResults((prev) =>
          prev.map((r) =>
            r.id === row['_id']
              ? { ...r, stage: 'error', error: `No ${site.label} config found for product type: ${row.product_type || '(empty)'}` }
              : r,
          ),
        );
        return;
      }

      const path = resolveOutputPath(row, cfg);
      if (!path) {
        setResults((prev) => prev.map((r) => (
          r.id === row['_id']
            ? { ...r, stage: 'error', error: `Output path must remain inside ${site.daRoot}` }
            : r
        )));
        return;
      }
      setResults((prev) =>
        prev.map((r) => (r.id === row['_id'] ? { ...r, path, stage: 'generating' } : r)),
      );

      try {
        let templateHtml = templateCache.get(cfg.templatePath);
        if (!templateHtml) {
          templateHtml = await cat(cfg.templatePath);
          templateCache.set(cfg.templatePath, templateHtml);
        }
        const html = finalizeGeneratedDoc(applyTemplate(templateHtml, row), row, { generatedBatch });
        const qa = runGenerationQa(html);
        if (existenceSnapshot[path] === 'exists') {
          try {
            await createDocVersion(path, 'Pre-generation backup');
          } catch { /* best-effort: proceed with write even if versioning fails */ }
        }
        const res = await postDoc(path, html);
        setResults((prev) =>
          prev.map((r) =>
            r.id === row['_id']
              ? { ...r, stage: 'generated', qa, editUrl: res.source?.editUrl }
              : r,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setResults((prev) =>
          prev.map((r) => (r.id === row['_id'] ? { ...r, stage: 'error', error: msg } : r)),
        );
      }
    }

    async function worker() {
      while (idx < queue.length) {

        await processRow(queue[idx++]);
      }
    }

    await Promise.all(Array.from({ length: Math.min(generateConcurrency, queue.length) }, worker));
    setBulkOp('idle');
  }

  async function handleGenerateRow(rowId: string) {
    const row = rows.find((r) => r['_id'] === rowId);
    if (!row) return;
    const cfg = resolveConfig(row.product_type ?? '');
    if (!cfg) {
      setResults((prev) =>
        prev.map((r) =>
          r.id === rowId
            ? { ...r, stage: 'error', error: `No ${site.label} config found for product type: ${row.product_type || '(empty)'}` }
            : r,
        ),
      );
      return;
    }
    const path = resolveOutputPath(row, cfg);
    if (!path) {
      setResults((prev) => prev.map((r) => (
        r.id === rowId
          ? { ...r, stage: 'error', error: `Output path must remain inside ${site.daRoot}` }
          : r
      )));
      return;
    }
    setResults((prev) => prev.map((r) => r.id === rowId ? { ...r, path, stage: 'generating' } : r));
    try {
      const templateHtml = await cat(cfg.templatePath);
      const html = finalizeGeneratedDoc(applyTemplate(templateHtml, row), row, {
        generatedBatch: new Date().toISOString(),
      });
      const qa = runGenerationQa(html);
      let existed = false;
      try { existed = await docExists(path); } catch { /* skip versioning if check fails */ }
      if (existed) {
        try {
          await createDocVersion(path, 'Pre-generation backup');
        } catch { /* best-effort */ }
      }
      const res = await postDoc(path, html);
      setResults((prev) => prev.map((r) =>
        r.id === rowId ? { ...r, stage: 'generated', qa, editUrl: res.source?.editUrl } : r,
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setResults((prev) => prev.map((r) => r.id === rowId ? { ...r, stage: 'error', error: msg } : r));
    }
  }

  async function handleBulkDelete() {
    setDeleteModalOpen(false);
    const targets = results.filter((r) =>
      ['generated', 'qa-fail', 'previewing', 'previewed', 'publishing',
        'published', 'unpublishing', 'unpublished'].includes(r.stage),
    );
    setBulkOp('deleting');
    await actions.deleteBulk(targets);
    setBulkOp('idle');
  }

  async function handlePreview() {
    const targets = results.filter((r) => r.stage === 'generated');
    setBulkOp('previewing');
    await actions.previewBulk(targets);
    setBulkOp('idle');
    setBulkProgress(null);
  }

  async function handlePublish() {
    // Note: stricter than showPublishBtn's counts.publishable (stage === 'previewed' only) —
    // rows that failed generation-time QA are intentionally excluded from the actual publish run.
    const targets = results.filter((r) => r.stage === 'previewed' && r.qa?.pass);
    setBulkOp('publishing');
    await actions.publishBulk(targets);
    setBulkOp('idle');
    setBulkProgress(null);
  }

  async function handleUnpublish() {
    const targets = results.filter((r) => r.stage === 'published');
    setBulkOp('unpublishing');
    await actions.unpublishBulk(targets);
    setBulkOp('idle');
    setBulkProgress(null);
  }

  const showPreviewBtn = !running && counts.previewable > 0;
  const showPublishBtn = !running && counts.publishable > 0;
  const showUnpublishBtn = !running && counts.published >= 2;
  const showDeleteBtn = !running && counts.deletable >= 2;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 bg-gray-200 text-gray-600">
          3
        </span>
        <h2 className="font-medium text-gray-900">Generate</h2>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {results.length > 0 && !running && (
          <button
            type="button"
            onClick={() => setResetModalOpen(true)}
            className="px-5 py-2.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-xl hover:bg-gray-200 cursor-pointer transition-colors border border-gray-200"
          >
            Reset Results
          </button>
        )}

        <label className="flex items-center gap-1.5 text-xs text-gray-600" title="How many document writes run in parallel. Higher is faster but may hit DA rate limits; retry absorbs transient throttling.">
          Write concurrency
          <input
            type="number"
            min={1}
            max={24}
            value={generateConcurrency}
            disabled={running}
            onChange={(e) => setGenerateConcurrency(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
            className="w-14 h-7 px-1.5 border border-gray-300 rounded-lg text-xs disabled:opacity-50"
          />
        </label>

        <div className="relative group inline-block">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={running || !!effectiveBlockReason}
            className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {bulkOp === 'generating'
              ? `Generating… ${counts.generated + counts.error} / ${results.length}`
              : `Generate ${rowsToGenerate.length} document${rowsToGenerate.length !== 1 ? 's' : ''}`}
          </button>
          {effectiveBlockReason && (
            <div className="absolute bottom-full left-0 mb-1.5 px-2.5 py-1.5 bg-gray-800 text-white text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-10 transition-opacity duration-150">
              {effectiveBlockReason}
            </div>
          )}
        </div>

        {showPreviewBtn && (
          <button
            type="button"
            onClick={handlePreview}
            className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 cursor-pointer transition-colors"
          >
            Preview {counts.previewable} document{counts.previewable !== 1 ? 's' : ''}
          </button>
        )}

        {bulkOp === 'previewing' && (
          <span className="text-sm text-indigo-600 font-medium">
            Previewing… {bulkProgress ? `${bulkProgress.done} / ${bulkProgress.total}` : '…'}
          </span>
        )}

        {showPublishBtn && (
          <button
            type="button"
            onClick={handlePublish}
            className="px-5 py-2.5 bg-green-600 text-white text-sm font-medium rounded-xl hover:bg-green-700 cursor-pointer transition-colors"
          >
            Publish to AEM Live ({counts.publishable})
          </button>
        )}

        {showPublishBtn && (
          <label className="flex items-center gap-1.5 text-xs text-gray-600" title="Run page QA on published pages after publish. Sampling avoids fetching every live page at scale.">
            QA
            <select
              value={publishQaMode.mode}
              onChange={(e) => {
                const m = e.target.value as PublishQaConfig['mode'];
                setPublishQaMode(m === 'sample' ? { mode: 'sample', sampleSize: 10 } : { mode: m });
              }}
              className="h-7 px-1.5 border border-gray-300 rounded-lg text-xs cursor-pointer"
            >
              <option value="off">Off</option>
              <option value="sample">Sample 10</option>
              <option value="all">All</option>
            </select>
          </label>
        )}

        {bulkOp === 'publishing' && (
          <span className="text-sm text-green-600 font-medium">
            Publishing… {bulkProgress ? `${bulkProgress.done} / ${bulkProgress.total}` : '…'}
          </span>
        )}

        {showUnpublishBtn && (
          <button
            type="button"
            onClick={handleUnpublish}
            className="px-5 py-2.5 bg-red-600 text-white text-sm font-medium rounded-xl hover:bg-red-700 cursor-pointer transition-colors"
          >
            Remove {counts.published} from AEM Live
          </button>
        )}

        {bulkOp === 'unpublishing' && (
          <span className="text-sm text-red-600 font-medium">
            Unpublishing… {bulkProgress ? `${bulkProgress.done} / ${bulkProgress.total}` : '…'}
          </span>
        )}

        {showDeleteBtn && (
          <button
            type="button"
            onClick={() => setDeleteModalOpen(true)}
            className="px-5 py-2.5 bg-red-700 text-white text-sm font-medium rounded-xl hover:bg-red-800 cursor-pointer transition-colors"
          >
            Delete {counts.deletable} documents
          </button>
        )}

        {bulkOp === 'deleting' && (
          <span className="text-sm text-red-700 font-medium">
            Deleting…
          </span>
        )}

        {results.length > 0 && (
          <div className="ml-auto flex items-center gap-3">
            {!running && (
              <p className="text-sm text-gray-500">
                {counts.generated > 0 && <span className="text-green-600 font-medium">{counts.generated} generated </span>}
                {counts.previewed > 0 && <span className="text-indigo-600 font-medium">{counts.previewed} previewed </span>}
                {counts.published > 0 && <span className="text-green-700 font-medium">{counts.published} published </span>}
                {counts.error > 0 && <span className="text-red-600 font-medium">{counts.error} error</span>}
              </p>
            )}
            <div ref={exportMenuRef} className="relative">
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
                  { kind: 'prod', label: 'Production hostname' },
                ];
                return (
                  <div className="absolute right-0 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg z-10 overflow-hidden">
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
        )}
      </div>

      {(results.length > 0 || previewRows.length > 0) && (
        <>
          {results.length === 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-gray-500">
                Showing output paths for {activePreview.length} document{activePreview.length !== 1 ? 's' : ''} — click Generate to create them
                {includeDuplicates && existingCount > 0 && (
                  <span className="text-amber-600 font-medium ml-1">
                    · {existingCount} will overwrite existing content
                  </span>
                )}
              </p>
              {existingCount > 0 && (
                <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
                  <input
                    type="checkbox"
                    checked={includeDuplicates}
                    onChange={(e) => setIncludeDuplicates(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 accent-indigo-600"
                  />
                  <span className="text-xs font-medium text-gray-600">
                    Include {existingCount} document{existingCount !== 1 ? 's' : ''} that already exist{existingCount === 1 ? 's' : ''} (overwrite)
                  </span>
                </label>
              )}
            </div>
          )}
          {(results.length > 0 || activePreview.length > 0) && (
          <div className="overflow-x-auto rounded-xl border border-gray-200 max-h-96 overflow-y-auto">
            <table className="text-xs min-w-max">
              <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-600 min-w-[280px]">Path</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600 w-28">Issues</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600 w-28">Generate</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600 w-44">Preview</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600 w-52">AEM Live</th>
                </tr>
              </thead>
              <tbody>
              {results.length === 0 && activePreview.map((pr) => (
                <tr key={pr.id} className="border-b border-gray-100 opacity-60">
                  <td className="px-3 py-2 font-mono whitespace-nowrap min-w-[280px]">
                    {!pr.hasConfig
                      ? <span className="text-amber-600 font-sans">No config for &ldquo;{pr.productType || '(none)'}&rdquo;</span>
                      : <span className="inline-flex items-center gap-2">
                          {existenceStatus[pr.path] === 'exists' ? (
                            <a href={`https://da.live/edit#${pr.path}`} target="_blank" rel="noopener noreferrer" className="text-amber-600 hover:underline inline-flex items-center gap-1">
                              {pr.path}
                              <ExternalLinkIcon />
                            </a>
                          ) : (
                            <span className="text-gray-500">{pr.path}</span>
                          )}
                          <ExistenceBadge status={existenceStatus[pr.path]} />
                        </span>
                    }
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="text-gray-300">—</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button type="button" disabled className="text-xs text-gray-300 font-medium cursor-not-allowed">Generate</button>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="text-gray-300">—</span></td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="text-gray-300">—</span></td>
                </tr>
              ))}
              {results.map((r) => (
                <Fragment key={r.id}>
                  <tr className="border-b border-gray-100">
                    <td className="px-3 py-2 font-mono text-gray-600 whitespace-nowrap min-w-[280px]">
                      <span className="inline-flex items-center gap-2">
                        {r.editUrl ? (
                          <a href={r.editUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                            {r.path}
                            <ExternalLinkIcon />
                          </a>
                        ) : r.path}
                        <ExistenceOutcomeBadge status={existenceStatus[r.path]} />
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <QaIssueBadge
                        qa={r.qa}
                        expanded={expandedRowId === r.id}
                        onToggle={() => toggleRowDetail(r.id)}
                      />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <GeneratePill
                        result={r}
                        onGenerate={() => handleGenerateRow(r.id)}
                        onDelete={() => actions.deleteRow(r)}
                      />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <PreviewPill result={r} onPreview={() => actions.previewRow(r)} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <PublishPill result={r} onPublish={() => actions.publishRow(r)} onUnpublish={() => actions.unpublishRow(r)} />
                    </td>
                  </tr>
                  {expandedRowId === r.id && r.qa && (
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <td colSpan={5} className="px-4 py-3">
                        <div className="flex flex-col gap-2">
                          {r.qa.checks.map((check) => (
                            <div key={check.id} className="flex gap-2 items-start">
                              <span className={`shrink-0 font-semibold ${check.pass ? 'text-green-600' : 'text-amber-700'}`}>
                                {check.pass ? '✓' : '✗'}
                              </span>
                              <div className="flex flex-col gap-0.5">
                                <span className={`font-semibold ${check.pass ? 'text-gray-700' : 'text-amber-900'}`}>
                                  {check.label}
                                </span>
                                <span className="text-gray-500">{check.description}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
          )}
        {results.length === 0 && excludedPreview.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-gray-500">
              <span className="font-medium text-gray-600">{excludedPreview.length}</span> excluded — already exist in DA
            </p>
            <div className="rounded-xl border border-gray-200 bg-gray-50 divide-y divide-gray-100 max-h-64 overflow-y-auto">
              {excludedPreview.map((pr) => (
                <div key={pr.id} className="px-3 py-2 flex items-center gap-2 text-xs font-mono opacity-60">
                  <a href={`https://da.live/edit#${pr.path}`} target="_blank" rel="noopener noreferrer" className="text-amber-600 hover:underline inline-flex items-center gap-1">
                    {pr.path}
                    <ExternalLinkIcon />
                  </a>
                  <ExistenceBadge status={existenceStatus[pr.path]} />
                </div>
              ))}
            </div>
          </div>
        )}
        </>
      )}

      {resetModalOpen && (
        <ConfirmModal
          title="Reset results?"
          confirmLabel="Reset"
          confirmClassName="px-4 py-2 bg-gray-800 text-white text-sm font-medium rounded-xl hover:bg-gray-900 cursor-pointer transition-colors"
          onCancel={() => setResetModalOpen(false)}
          onConfirm={() => { setResults([]); setExistenceStatus({}); checkedPaths.current.clear(); dirListCache.current.clear(); setResetModalOpen(false); }}
        >
          <p className="text-sm text-gray-500">
            This will clear all {results.length} result{results.length !== 1 ? 's' : ''} from this
            view and unlock the data inputs. Documents already written to DA are not
            deleted — use the Delete button to remove them first.
          </p>
        </ConfirmModal>
      )}

      {deleteModalOpen && (
        <ConfirmModal
          title={`Delete ${counts.deletable} document${counts.deletable !== 1 ? 's' : ''}?`}
          confirmLabel="Delete"
          onCancel={() => setDeleteModalOpen(false)}
          onConfirm={handleBulkDelete}
        >
          <p className="text-sm text-gray-500">
            This will permanently delete the following documents from DA:
          </p>
          <ul className="text-xs font-mono text-gray-700 max-h-64 overflow-y-auto border border-gray-100 rounded-lg p-3 flex flex-col gap-1">
            {results
              .filter((r) =>
                ['generated', 'qa-fail', 'previewing', 'previewed', 'publishing',
                  'published', 'unpublishing', 'unpublished'].includes(r.stage),
              )
              .map((r) => <li key={r.id} className="whitespace-nowrap">{r.path}</li>)}
          </ul>
        </ConfirmModal>
      )}
    </div>
  );
}

