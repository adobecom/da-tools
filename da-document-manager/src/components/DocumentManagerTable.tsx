import { memo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { DocRow } from '../types';
import type { DaDocumentActions } from '../hooks/useDaDocumentActions';
import { PreviewPill, PublishPill, UnpublishPill, DeleteButton, ExternalLinkIcon } from './StatusCells';

export type SortField = 'path' | 'lastUpdated' | 'status';

interface Props {
  rows: DocRow[];
  selected: Set<string>;
  onToggleSelect: (path: string) => void;
  onToggleSelectAll: () => void;
  allSelected: boolean;
  sortField: SortField;
  sortDirection: 'asc' | 'desc';
  onSort: (field: SortField) => void;
  actions: DaDocumentActions<DocRow>;
}

const SORT_COLUMNS: { field: SortField; label: string }[] = [
  { field: 'path', label: 'Path' },
  { field: 'lastUpdated', label: 'Last updated' },
  { field: 'status', label: 'Status' },
];

// Fixed column widths shared by the header and every row so a single CSS grid template keeps them
// aligned while the body is virtualized. Order: checkbox, Path, Last updated, Status, Preview,
// Publish, Unpublish, Delete. Deriving the template + total width from one array keeps them from drifting.
const COLUMN_WIDTHS = [44, 560, 210, 120, 120, 120, 120, 90];
const GRID_TEMPLATE = COLUMN_WIDTHS.map((w) => `${w}px`).join(' ');
const TOTAL_WIDTH = COLUMN_WIDTHS.reduce((a, b) => a + b, 0);

/** Normalize a `/list` or status timestamp (epoch seconds/ms, numeric string, or ISO) for display. */
export function formatTimestamp(v: string | number | undefined): string {
  if (v === undefined || v === null || v === '') return '—';
  let ms: number;
  if (typeof v === 'number') {
    ms = v < 1e12 ? v * 1000 : v; // seconds vs milliseconds heuristic
  } else {
    const n = Number(v);
    ms = Number.isNaN(n) ? Date.parse(v) : n < 1e12 ? n * 1000 : n;
  }
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleString();
}

export default function DocumentManagerTable({
  rows,
  selected,
  onToggleSelect,
  onToggleSelectAll,
  allSelected,
  sortField,
  sortDirection,
  onSort,
  actions,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 37,
    overscan: 10,
    getItemKey: (index) => rows[index].path,
  });

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
        No documents match the current filters.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="rounded-xl border border-gray-200 max-h-[32rem] overflow-auto">
      <div style={{ width: TOTAL_WIDTH }}>
        {/* Header — same grid template as the rows so columns line up */}
        <div
          className="grid bg-gray-50 border-b border-gray-200 sticky top-0 z-10 text-xs"
          style={{ gridTemplateColumns: GRID_TEMPLATE }}
        >
          <div className="px-3 py-2 flex items-center">
            <input type="checkbox" checked={allSelected} onChange={onToggleSelectAll} className="cursor-pointer" />
          </div>
          {SORT_COLUMNS.map(({ field, label }) => (
            <div key={field} className="px-3 py-2 font-medium text-gray-600 truncate">
              <button
                type="button"
                onClick={() => onSort(field)}
                className="inline-flex items-center gap-1 cursor-pointer hover:text-gray-900"
              >
                {label}
                {sortField === field && <span className="text-[10px]">{sortDirection === 'asc' ? '▲' : '▼'}</span>}
              </button>
            </div>
          ))}
          <div className="px-3 py-2 font-medium text-gray-600">Preview</div>
          <div className="px-3 py-2 font-medium text-gray-600">Publish</div>
          <div className="px-3 py-2 font-medium text-gray-600">Unpublish</div>
          <div className="px-3 py-2 font-medium text-gray-600">Delete</div>
        </div>

        {/* Virtualized body — only visible rows are mounted */}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => (
            <DocumentRow
              key={vi.key}
              dataIndex={vi.index}
              measureRef={virtualizer.measureElement}
              start={vi.start}
              doc={rows[vi.index]}
              isSelected={selected.has(rows[vi.index].path)}
              onToggleSelect={onToggleSelect}
              actions={actions}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  doc: DocRow;
  isSelected: boolean;
  dataIndex: number;
  start: number;
  measureRef: (el: HTMLElement | null) => void;
  onToggleSelect: (path: string) => void;
  actions: DaDocumentActions<DocRow>;
}

const DocumentRow = memo(function DocumentRow({
  doc,
  isSelected,
  dataIndex,
  start,
  measureRef,
  onToggleSelect,
  actions,
}: RowProps) {
  return (
    <div
      data-index={dataIndex}
      ref={measureRef}
      className={`grid items-center border-b border-gray-100 text-xs ${isSelected ? 'bg-blue-50/50' : ''}`}
      style={{
        gridTemplateColumns: GRID_TEMPLATE,
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${start}px)`,
      }}
    >
      <div className="px-3 py-2 flex items-center">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(doc.path)}
          className="cursor-pointer"
        />
      </div>
      <div className="px-3 py-2 font-mono overflow-x-auto whitespace-nowrap no-scrollbar" title={doc.path}>
        <a
          href={`https://da.live/edit#${doc.path}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline inline-flex items-center gap-1"
        >
          {doc.path}
          <ExternalLinkIcon />
        </a>
      </div>
      <div className="px-3 py-2 text-gray-500 overflow-x-auto whitespace-nowrap no-scrollbar">
        {formatTimestamp(doc.lastUpdated)}
      </div>
      <div className="px-3 py-2 truncate">
        <StatusLabel doc={doc} />
      </div>
      <div className="px-3 py-2">
        <PreviewPill result={doc} onPreview={() => actions.previewRow(doc)} />
      </div>
      <div className="px-3 py-2">
        <PublishPill result={doc} onPublish={() => actions.publishRow(doc)} />
      </div>
      <div className="px-3 py-2">
        <UnpublishPill result={doc} onUnpublish={() => actions.unpublishRow(doc)} />
      </div>
      <div className="px-3 py-2">
        <DeleteButton result={doc} onDelete={() => actions.deleteRow(doc)} />
      </div>
    </div>
  );
});

function StatusLabel({ doc }: { doc: DocRow }) {
  const { stage } = doc;
  if (doc.statusUnknown) {
    return (
      <span className="text-gray-400 font-medium" title="Publish status check failed (rate-limited or unreachable) — the real state is unknown. Recheck to retry.">
        Unknown
      </span>
    );
  }
  if (stage === 'published') return <span className="text-green-700 font-medium">Published</span>;
  if (stage === 'previewed') return <span className="text-indigo-600 font-medium">Previewed</span>;
  if (stage === 'unpublished') return <span className="text-amber-600 font-medium">Unpublished</span>;
  if (stage === 'error') return <span className="text-red-600 font-medium">Error</span>;
  if (['previewing', 'publishing', 'unpublishing', 'deleting'].includes(stage)) {
    return <span className="text-gray-500 font-medium">{stage}…</span>;
  }
  return <span className="text-gray-500 font-medium">Draft</span>;
}
