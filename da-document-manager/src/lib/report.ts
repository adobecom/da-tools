import { daPathToLiveUrl, daPathToPreviewUrl, daPathToProdUrl } from '../api/daApi';
import { copyResultLabel } from './copyEdit';
import type { DocRow } from '../types';

export type ReportStatus = 'draft' | 'previewed' | 'published' | 'unknown';

function toIso(v: string | number | undefined): string {
  if (v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  const ms = Number.isNaN(n) ? Date.parse(String(v)) : n < 1e12 ? n * 1000 : n;
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}

export function reportRows(rows: DocRow[], statusOf: (d: DocRow) => ReportStatus) {
  return rows.map((d) => ({
    path: d.path,
    folder: d.subDirectory,
    status: statusOf(d),
    lastUpdated: toIso(d.lastUpdated),
    copyResult: d.copyResult ? copyResultLabel(d.copyResult) : '',
    copyAction: d.copyResult
      ? d.copyResult.direction === 'rollback' ? 'rollback'
        : `${d.copyResult.direction === 'dry-run' ? 'dry run: ' : ''}${d.copyResult.mode ?? 'text'}`
      : '',
    copyDetail: d.copyResult?.detail ?? '',
    error: d.error ?? '',
    editUrl: `https://da.live/edit#${d.path.replace(/\.html$/, '')}`,
    previewUrl: daPathToPreviewUrl(d.path),
    liveUrl: daPathToLiveUrl(d.path),
    prodUrl: daPathToProdUrl(d.path),
  }));
}

function tally<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of items) out[key(t)] = (out[key(t)] ?? 0) + 1;
  return out;
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ReturnType<typeof reportRows>): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]) as (keyof (typeof rows)[number])[];
  return `${[cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n')}\n`;
}

/** JSON report: the rows plus counts by copy result, status, and top-level folder (product type). */
export function toJson(rows: ReturnType<typeof reportRows>, meta: { root: string | null; filters: Record<string, string> }): string {
  const topFolder = (f: string) => f.split('/').filter(Boolean)[0] ?? '/';
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    root: meta.root,
    filters: meta.filters,
    summary: {
      documents: rows.length,
      byCopyResult: tally(rows, (r) => r.copyResult || '(not run)'),
      byStatus: tally(rows, (r) => r.status),
      byFolder: Object.fromEntries(
        Object.entries(
          rows.reduce<Record<string, ReturnType<typeof reportRows>>>((acc, r) => {
            (acc[topFolder(r.folder)] ??= []).push(r);
            return acc;
          }, {}),
        ).map(([folder, rs]) => [folder, tally(rs, (r) => r.copyResult || '(not run)')]),
      ),
    },
    documents: rows,
  }, null, 2);
}

export function downloadText(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
