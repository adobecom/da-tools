import { afterEach, describe, expect, it, vi } from 'vitest';
import { bulkStatus, setToken } from '../src/api/daApi';

const PATHS = ['/adobecom/da-express-milo/express/print/card/a.html', '/adobecom/da-express-milo/express/print/card/b.html'];

function stubJob(resources: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (init?.method === 'POST') return json({ job: { name: 'job-1', topic: 'status' } });
    if (url.endsWith('/details')) return json({ data: { resources } });
    return json({ state: 'stopped' });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('bulkStatus', () => {
  setToken('test-token');

  it('maps timestamps per DA path', async () => {
    stubJob([
      { path: '/express/print/card/a', sourceLastModified: 'Wed, 30 Sep 2026 17:28:00 GMT', publishLastModified: 'Thu, 01 Oct 2026 00:00:00 GMT' },
      { path: '/express/print/card/b', sourceLastModified: 'Wed, 30 Sep 2026 17:28:00 GMT' },
    ]);
    const out = await bulkStatus(PATHS);
    expect(out.get(PATHS[0])).toMatchObject({ ok: true, publishLastModified: Date.parse('2026-10-01T00:00:00Z') });
    expect(out.get(PATHS[1])).toMatchObject({ ok: true, publishLastModified: undefined });
  });

  it('refuses an unrecognized response shape instead of reading pages as not live', async () => {
    stubJob([{ path: '/express/print/card/a', status: 200 }, { path: '/express/print/card/b', status: 200 }]);
    await expect(bulkStatus(PATHS)).rejects.toThrow(/unrecognized shape/);
  });

  it('marks a resource without a source timestamp as unknown', async () => {
    stubJob([
      { path: '/express/print/card/a', sourceLastModified: 'Wed, 30 Sep 2026 17:28:00 GMT' },
      { path: '/express/print/card/b', previewLastModified: 'Wed, 30 Sep 2026 17:28:00 GMT' },
    ]);
    const out = await bulkStatus(PATHS);
    expect(out.get(PATHS[1])?.ok).toBe(false);
  });
});
