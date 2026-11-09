import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { daPathToEditUrl, daPathToLiveUrl } from '../api/daApi';
import { resultFor, UPDATE_BUCKETS, type DocRecord } from '../engine/model';

function tone(result: string): string {
  if (result.startsWith('failed') || result === 'scan-error' || result.includes('check failed')) return 'bg-red-100 text-red-800';
  if (result === 'published' || result.startsWith('updated (source') || result === 'already-updated') return 'bg-green-100 text-green-800';
  if (result.startsWith('pending') || result.startsWith('updated') || result.startsWith('previewed')) return 'bg-blue-100 text-blue-800';
  return 'bg-amber-100 text-amber-800';
}

const ROW_HEIGHT = 36;

export function ResultsTable({ records, root }: { records: DocRecord[]; root: string }) {
  const [filter, setFilter] = useState<string | null>(null);
  const withResult = useMemo(() => records.map((r) => ({ r, result: resultFor(r) })), [records]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const { result } of withResult) c.set(result, (c.get(result) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [withResult]);
  const rows = useMemo(() => (filter ? withResult.filter((x) => x.result === filter) : withResult), [withResult, filter]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-wrap gap-2 border-b border-gray-200 p-3">
        <button
          onClick={() => setFilter(null)}
          className={`rounded-full px-3 py-1 text-xs ${filter === null ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-700'}`}
        >
          All {records.length.toLocaleString()}
        </button>
        {counts.map(([result, n]) => (
          <button
            key={result}
            onClick={() => setFilter(filter === result ? null : result)}
            className={`rounded-full px-3 py-1 text-xs ${filter === result ? 'ring-2 ring-gray-800' : ''} ${tone(result)}`}
          >
            {result} {n.toLocaleString()}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[minmax(0,2.2fr)_110px_190px_minmax(0,2fr)_48px] gap-3 border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-600">
            <span>Document</span><span>Type</span><span>Result</span><span>Reason / details</span><span>Live</span>
          </div>
          <div ref={parentRef} className="h-[480px] overflow-y-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const { r, result } = rows[vi.index];
                const reason = r.skipReason ?? r.error ?? r.detail ?? '';
                const showLive = r.publishLastModified !== undefined || r.stage === 'published';
                return (
                  <div
                    key={r.path}
                    className="absolute left-0 grid w-full grid-cols-[minmax(0,2.2fr)_110px_190px_minmax(0,2fr)_48px] items-center gap-3 border-b border-gray-100 px-3 text-xs"
                    style={{ height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                  >
                    <a href={daPathToEditUrl(r.path)} target="_blank" rel="noreferrer" className="truncate text-blue-700 hover:underline" title={r.path}>
                      {r.path.slice(root.length + 1).replace(/\.html$/, '')}
                    </a>
                    <span className="truncate text-gray-600">{r.productType}</span>
                    <span><span className={`rounded px-2 py-0.5 ${tone(result)}`}>{result}</span></span>
                    <span className="truncate text-gray-600" title={reason}>
                      {reason || (UPDATE_BUCKETS.has(r.bucket) && r.publishLastModified ? `published ${new Date(r.publishLastModified).toLocaleDateString()}` : '')}
                    </span>
                    <span>
                      {showLive && <a href={daPathToLiveUrl(r.path)} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">↗</a>}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TypeSummary({ records }: { records: DocRecord[] }) {
  const rows = useMemo(() => {
    const m = new Map<string, { total: number; toUpdate: number; done: number; skipped: number; failed: number }>();
    for (const r of records) {
      const row = m.get(r.productType) ?? { total: 0, toUpdate: 0, done: 0, skipped: 0, failed: 0 };
      row.total += 1;
      const isUpdate = UPDATE_BUCKETS.has(r.bucket);
      if (isUpdate && r.stage !== 'skipped') row.toUpdate += 1;
      if (r.stage === 'published' || (r.stage === 'updated' && r.bucket === 'update-source-only')) row.done += 1;
      if (r.stage === 'skipped' || (!isUpdate && r.bucket !== 'already-updated')) row.skipped += 1;
      if (r.error || r.bucket === 'scan-error') row.failed += 1;
      m.set(r.productType, row);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [records]);
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full min-w-[520px] text-xs">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            {['Product type', 'Documents', 'To update', 'Done', 'Skipped', 'Failed'].map((h) => (
              <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([type, c]) => (
            <tr key={type} className="border-t border-gray-100 tabular-nums">
              <td className="px-3 py-1.5">{type}</td>
              <td className="px-3 py-1.5">{c.total.toLocaleString()}</td>
              <td className="px-3 py-1.5">{c.toUpdate.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-green-700">{c.done.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-amber-700">{c.skipped.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-red-700">{c.failed.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
