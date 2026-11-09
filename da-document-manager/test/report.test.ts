import { describe, expect, it } from 'vitest';
import { reportRows, toCsv, toJson } from '../src/lib/report';
import type { DocRow } from '../src/types';

const rows: DocRow[] = [
  { id: '1', path: '/adobecom/da-express-milo/express/print/card/a.html', subDirectory: '/card', stage: 'published', lastUpdated: 1790789290599, copyResult: { direction: 'update', mode: 'text', outcome: 'changed' } },
  { id: '2', path: '/adobecom/da-express-milo/express/print/card/b.html', subDirectory: '/card', stage: 'draft', copyResult: { direction: 'update', mode: 'text', outcome: 'variant', detail: '<h2> Free shipping, "fast"' } },
  { id: '3', path: '/adobecom/da-express-milo/express/print/flyer/c.html', subDirectory: '/flyer', stage: 'previewed' },
];
const statusOf = (d: DocRow) => (d.stage === 'published' ? 'published' : d.stage === 'previewed' ? 'previewed' : 'draft') as 'published' | 'previewed' | 'draft';

describe('report', () => {
  it('builds one CSV row per document with escaped values', () => {
    const csv = toCsv(reportRows(rows, statusOf)).trim().split('\n');
    expect(csv[0]).toBe('path,folder,status,lastUpdated,copyResult,copyAction,copyDetail,error,editUrl,previewUrl,liveUrl,prodUrl');
    expect(csv).toHaveLength(4);
    expect(csv[1]).toContain('Updated,text');
    expect(csv[2]).toContain('"<h2> Free shipping, ""fast"""');
    expect(csv[1]).toContain('https://www.adobe.com/express/print/card/a');
  });

  it('adds summary counts by copy result, status and folder to the JSON', () => {
    const json = JSON.parse(toJson(reportRows(rows, statusOf), { root: '/adobecom/da-express-milo/express/print', filters: {} }));
    expect(json.summary.byCopyResult).toEqual({ Updated: 1, 'Different wording': 1, '(not run)': 1 });
    expect(json.summary.byStatus).toEqual({ published: 1, draft: 1, previewed: 1 });
    expect(json.summary.byFolder.card).toEqual({ Updated: 1, 'Different wording': 1 });
    expect(json.documents).toHaveLength(3);
  });
});
