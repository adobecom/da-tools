import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const base = readFileSync(resolve(__dirname, 'fixtures/highlight-row.html'), 'utf8');
const store = new Map<string, string>();
const versions: { path: string; label: string; html: string }[] = [];
let failWrite = false;

vi.mock('../src/api/daApi', () => ({
  cat: async (p: string) => store.get(p)!,
  writeSource: async (p: string, html: string) => {
    if (failWrite) throw new Error('write 500');
    store.set(p, html);
  },
  createVersion: async (p: string, label: string) => { versions.push({ path: p, label, html: store.get(p)! }); },
}));

const { applyRule, applyRuleBulk, copyResultLabel } = await import('../src/lib/copyEdit');
const { SHIPPING_COPY } = await import('../src/lib/copyPresets');

beforeEach(() => { store.clear(); versions.length = 0; failWrite = false; });

describe('shipping copy edit', () => {
  it('updates only the highlight row and saves a version first', async () => {
    store.set('/a.html', base);
    expect(await applyRule('/a.html', SHIPPING_COPY.update)).toEqual({ outcome: 'changed' });
    expect(store.get('/a.html')).toBe(base.replace('<h2>Free shipping and returns</h2>', '<h2>Easy 30-day returns</h2>'));
    expect(versions).toEqual([{ path: '/a.html', label: 'Before MWPW-214582 copy update', html: base }]);
  });

  it('is safe to re-run', async () => {
    store.set('/a.html', base);
    await applyRule('/a.html', SHIPPING_COPY.update);
    expect(await applyRule('/a.html', SHIPPING_COPY.update)).toEqual({ outcome: 'unchanged' });
    expect(versions).toHaveLength(1);
  });

  it('revert restores the original exactly and keeps later edits', async () => {
    store.set('/a.html', base);
    await applyRule('/a.html', SHIPPING_COPY.update);
    const edited = store.get('/a.html')!.replace('Yellow Technology', 'Author edit');
    store.set('/a.html', edited);
    expect(await applyRule('/a.html', SHIPPING_COPY.revert)).toEqual({ outcome: 'changed' });
    expect(store.get('/a.html')).toBe(base.replace('Yellow Technology', 'Author edit'));
    expect(versions[1].label).toBe('Before MWPW-214582 copy revert');
  });

  it('reports different wording without editing', async () => {
    const html = base.replace('Free shipping and returns', 'Free shipping &amp; returns');
    store.set('/a.html', html);
    const r = await applyRule('/a.html', SHIPPING_COPY.update);
    expect(r.outcome).toBe('variant');
    expect(store.get('/a.html')).toBe(html);
    expect(versions).toHaveLength(0);
  });

  it('bulk run reports every document, including failures', async () => {
    store.set('/a.html', base);
    store.set('/b.html', base.replace('class="highlight"', 'class="other"'));
    store.set('/c.html', base);
    const seen = new Map();
    const results = await applyRuleBulk(['/a.html', '/b.html', '/c.html'], SHIPPING_COPY.update, 'update', (batch) => {
      for (const [k, v] of batch) seen.set(k, v);
    }, () => {});
    expect(seen.size).toBe(3);
    expect(copyResultLabel(results.get('/a.html')!)).toBe('Updated');
    expect(copyResultLabel(results.get('/b.html')!)).toBe('No matching block');

    failWrite = true;
    store.set('/d.html', base);
    const failed = await applyRuleBulk(['/d.html'], SHIPPING_COPY.update, 'update', () => {}, () => {});
    expect(failed.get('/d.html')).toMatchObject({ outcome: 'error', detail: 'write 500' });
  });
});
