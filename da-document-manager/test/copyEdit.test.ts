import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const base = readFileSync(resolve(__dirname, 'fixtures/highlight-row.html'), 'utf8');
const store = new Map<string, string>();
const versions: { path: string; label: string; html: string; t: number }[] = [];
let clock = 0;
let failWrite = false;

vi.mock('../src/api/daApi', () => ({
  cat: async (p: string) => store.get(p)!,
  writeSource: async (p: string, html: string) => {
    if (failWrite) throw new Error('write 500');
    store.set(p, html);
  },
  createVersion: async (p: string, label: string) => { versions.push({ path: p, label, html: store.get(p)!, t: ++clock }); },
  findVersionUrl: async (p: string, label: string) => {
    const v = versions.filter((x) => x.path === p && x.label === label).sort((a, b) => b.t - a.t)[0];
    return v ? `/versionsource/${versions.indexOf(v)}` : null;
  },
  readVersion: async (url: string) => versions[Number(url.split('/').pop())].html,
}));

const { applyUpdate, applyRollback, runCopyBulk, copyResultLabel } = await import('../src/lib/copyEdit');
const { SHIPPING_COPY } = await import('../src/lib/copyPresets');

beforeEach(() => { store.clear(); versions.length = 0; failWrite = false; });

describe('Update shipping copy', () => {
  it('updates only the highlight row, saving a version right before the write', async () => {
    store.set('/a.html', base);
    expect(await applyUpdate('/a.html', SHIPPING_COPY)).toEqual({ outcome: 'changed' });
    expect(store.get('/a.html')).toBe(base.replace('<h2>Free shipping and returns</h2>', '<h2>Easy 30-day returns</h2>'));
    expect(versions).toMatchObject([{ path: '/a.html', label: 'Before MWPW-214582 copy update', html: base }]);
  });

  it('is safe to re-run (no second version or write)', async () => {
    store.set('/a.html', base);
    await applyUpdate('/a.html', SHIPPING_COPY);
    expect(await applyUpdate('/a.html', SHIPPING_COPY)).toEqual({ outcome: 'unchanged' });
    expect(versions).toHaveLength(1);
  });

  it('reports different wording without a version or write', async () => {
    const html = base.replace('Free shipping and returns', 'Free shipping &amp; returns');
    store.set('/a.html', html);
    expect((await applyUpdate('/a.html', SHIPPING_COPY)).outcome).toBe('variant');
    expect(store.get('/a.html')).toBe(html);
    expect(versions).toHaveLength(0);
  });
});

describe('Rollback to previous version', () => {
  it('restores the saved version exactly, discarding later edits, and saves a rollback version first', async () => {
    store.set('/a.html', base);
    await applyUpdate('/a.html', SHIPPING_COPY);
    const edited = store.get('/a.html')!.replace('Yellow Technology', 'Later edit');
    store.set('/a.html', edited);

    expect(await applyRollback('/a.html', SHIPPING_COPY)).toEqual({ outcome: 'changed' });
    expect(store.get('/a.html')).toBe(base);
    expect(versions.at(-1)).toMatchObject({ label: 'Before MWPW-214582 rollback', html: edited });
  });

  it('leaves documents that already have the original copy alone', async () => {
    store.set('/a.html', base);
    expect(await applyRollback('/a.html', SHIPPING_COPY)).toEqual({ outcome: 'unchanged' });
    expect(versions).toHaveLength(0);
  });

  it('reports a document with no saved version', async () => {
    store.set('/a.html', base.replace('Free shipping and returns', 'Easy 30-day returns'));
    expect((await applyRollback('/a.html', SHIPPING_COPY)).outcome).toBe('no-version');
  });
});

describe('bulk', () => {
  it('reports every document, including failures', async () => {
    store.set('/a.html', base);
    store.set('/b.html', base.replace('class="highlight"', 'class="other"'));
    const seen = new Map();
    const results = await runCopyBulk(['/a.html', '/b.html'], SHIPPING_COPY, 'update', (batch) => {
      for (const [k, v] of batch) seen.set(k, v);
    }, () => {});
    expect(seen.size).toBe(2);
    expect(copyResultLabel(results.get('/a.html')!)).toBe('Updated');
    expect(copyResultLabel(results.get('/b.html')!)).toBe('No matching block');

    const rolled = await runCopyBulk(['/a.html'], SHIPPING_COPY, 'rollback', () => {}, () => {});
    expect(copyResultLabel(rolled.get('/a.html')!)).toBe('Rolled back');

    failWrite = true;
    store.set('/d.html', base);
    const failed = await runCopyBulk(['/d.html'], SHIPPING_COPY, 'update', () => {}, () => {});
    expect(failed.get('/d.html')).toMatchObject({ outcome: 'error', detail: 'write 500' });
  });
});
