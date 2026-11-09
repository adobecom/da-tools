import { daPathToAdobeUrl, daPathToEditUrl, daPathToLiveUrl, daPathToPreviewUrl } from '../api/daApi';
import { resultFor, type DocRecord } from './model';
import type { ReplaceRule } from './rule';

const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : '');

export function reportRows(records: DocRecord[]) {
  return records.map((r) => ({
    path: r.path,
    productType: r.productType,
    result: resultFor(r),
    scanBucket: r.bucket,
    reason: r.skipReason ?? r.error ?? r.detail ?? '',
    daLastModified: iso(r.daLastModified),
    sourceLastModified: iso(r.sourceLastModified),
    previewLastModified: iso(r.previewLastModified),
    publishLastModified: iso(r.publishLastModified),
    editUrl: daPathToEditUrl(r.path),
    previewUrl: daPathToPreviewUrl(r.path),
    liveUrl: daPathToLiveUrl(r.path),
    prodUrl: daPathToAdobeUrl(r.path) ?? '',
  }));
}

/** Counts by result, overall and per product type (the ticket's run-report requirement). */
export function summarize(records: DocRecord[]) {
  const total: Record<string, number> = {};
  const byType: Record<string, Record<string, number>> = {};
  for (const r of records) {
    const res = resultFor(r);
    total[res] = (total[res] ?? 0) + 1;
    byType[r.productType] ??= {};
    byType[r.productType][res] = (byType[r.productType][res] ?? 0) + 1;
  }
  return { scanned: records.length, total, byType };
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records: DocRecord[]): string {
  const rows = reportRows(records);
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]) as (keyof (typeof rows)[number])[];
  return [cols.join(','), ...rows.map((row) => cols.map((c) => csvCell(row[c])).join(','))].join('\n');
}

export function toJson(records: DocRecord[], root: string, rule: ReplaceRule): string {
  return JSON.stringify({
    rule: { id: rule.id, find: rule.find, replace: rule.replace, block: rule.blockClass },
    root,
    generatedAt: new Date().toISOString(),
    summary: summarize(records),
    docs: reportRows(records),
  }, null, 2);
}

/** URLs to hand to pdp-render-checker: stage adobe.com for /express pages, else aem.page. */
export function qaUrls(records: DocRecord[]): string {
  return records.map((r) => daPathToAdobeUrl(r.path, true) ?? daPathToPreviewUrl(r.path)).join('\n');
}

export function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
