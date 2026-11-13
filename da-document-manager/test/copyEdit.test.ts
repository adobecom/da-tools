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
  listVersions: async (p: string) => versions
    .map((v, i) => ({ ...v, i }))
    .filter((v) => v.path === p)
    .map((v) => ({ label: v.label, timestamp: v.t, url: `/versionsource/${v.i}` })),
  readVersion: async (url: string) => versions[Number(url.split('/').pop())].html,
}));

const { applyUpdate, applyRollback, applyFragmentSwap, runCopyBulk, copyResultLabel } = await import('../src/lib/copyEdit');
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

    expect(await applyRollback('/a.html', SHIPPING_COPY)).toEqual({ outcome: 'changed', detail: 'Restored "Before MWPW-214582 copy update" version' });
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
    const results = await runCopyBulk(['/a.html', '/b.html'], SHIPPING_COPY, 'update', 'text', (batch) => {
      for (const [k, v] of batch) seen.set(k, v);
    }, () => {});
    expect(seen.size).toBe(2);
    expect(copyResultLabel(results.get('/a.html')!)).toBe('Updated');
    expect(copyResultLabel(results.get('/b.html')!)).toBe('No matching block');

    const rolled = await runCopyBulk(['/a.html'], SHIPPING_COPY, 'rollback', 'text', () => {}, () => {});
    expect(copyResultLabel(rolled.get('/a.html')!)).toBe('Rolled back');

    failWrite = true;
    store.set('/d.html', base);
    const failed = await runCopyBulk(['/d.html'], SHIPPING_COPY, 'update', 'text', () => {}, () => {});
    expect(failed.get('/d.html')).toMatchObject({ outcome: 'error', detail: 'write 500' });
  });
});

describe('fragment swap', () => {
  const swap = SHIPPING_COPY.fragment!;
  const fragmentBlock = `<div class="fragment"><div><div><p><a href="${swap.fragmentUrl}">${swap.fragmentUrl}</a></p></div></div></div>`;
  const highlightStart = base.indexOf('<div class="highlight">');
  const highlightEnd = base.indexOf('<div class="faqv2') - '</div><div>'.length;
  const expected = base.slice(0, highlightStart) + fragmentBlock + base.slice(highlightEnd);

  it('replaces exactly the highlight block with a fragment block, nothing else', async () => {
    store.set('/a.html', base);
    expect(await applyFragmentSwap('/a.html', SHIPPING_COPY)).toEqual({ outcome: 'changed' });
    expect(store.get('/a.html')).toBe(expected);
    expect(store.get('/a.html')).not.toContain('class="highlight"');
    expect(store.get('/a.html')).toContain('class="faqv2 expandable"');
    expect(versions).toMatchObject([{ label: 'Before MWPW-214582 fragment swap', html: base }]);
  });

  it('also swaps a page that already has the text update', async () => {
    store.set('/a.html', base);
    await applyUpdate('/a.html', SHIPPING_COPY);
    expect((await applyFragmentSwap('/a.html', SHIPPING_COPY)).outcome).toBe('changed');
  });

  it('is safe to re-run', async () => {
    store.set('/a.html', base);
    await applyFragmentSwap('/a.html', SHIPPING_COPY);
    const r = await runCopyBulk(['/a.html'], SHIPPING_COPY, 'update', 'fragment', () => {}, () => {});
    expect(copyResultLabel(r.get('/a.html')!)).toBe('Already uses fragment');
    expect(versions).toHaveLength(1);
  });

  it('never touches a block that only uses "highlight" as a variant', async () => {
    const html = base.replace('class="highlight"', 'class="steps highlight schema"');
    store.set('/a.html', html);
    expect((await applyFragmentSwap('/a.html', SHIPPING_COPY)).outcome).toBe('no-block');
    expect(store.get('/a.html')).toBe(html);
  });

  it('skips a highlight block without the shipping row', async () => {
    const html = base.replace('Free shipping and returns', 'Fast delivery');
    store.set('/a.html', html);
    expect((await applyFragmentSwap('/a.html', SHIPPING_COPY)).outcome).toBe('no-match');
    expect(versions).toHaveLength(0);
  });

  it('rollback steps back one update at a time: fragment swap → text update → original', async () => {
    store.set('/a.html', base);
    await applyUpdate('/a.html', SHIPPING_COPY);
    const textUpdated = store.get('/a.html')!;
    await applyFragmentSwap('/a.html', SHIPPING_COPY);

    expect((await applyRollback('/a.html', SHIPPING_COPY)).outcome).toBe('changed');
    expect(store.get('/a.html')).toBe(textUpdated);
    expect((await applyRollback('/a.html', SHIPPING_COPY)).outcome).toBe('changed');
    expect(store.get('/a.html')).toBe(base);
    expect((await applyRollback('/a.html', SHIPPING_COPY)).outcome).toBe('unchanged');
  });
});

describe('dry run', () => {
  const docs: [string, string][] = [
    ['/match.html', base],
    ['/variant.html', base.replace('Free shipping and returns', 'Free shipping &amp; returns')],
    ['/noblock.html', base.replace('class="highlight"', 'class="other"')],
  ];

  it.each(['text', 'fragment'] as const)('%s mode: writes nothing, and predicts exactly what Update then does', async (mode) => {
    for (const [p, html] of docs) store.set(p, html);
    const paths = docs.map(([p]) => p);
    const before = new Map(store);

    const dry = await runCopyBulk(paths, SHIPPING_COPY, 'dry-run', mode, () => {}, () => {});
    expect(store).toEqual(before);
    expect(versions).toHaveLength(0);
    expect(copyResultLabel(dry.get('/match.html')!)).toBe(mode === 'fragment' ? 'Would replace with fragment' : 'Would update');

    const real = await runCopyBulk(paths, SHIPPING_COPY, 'update', mode, () => {}, () => {});
    for (const p of paths) expect(real.get(p)!.outcome).toBe(dry.get(p)!.outcome);

    const again = await runCopyBulk(paths, SHIPPING_COPY, 'dry-run', mode, () => {}, () => {});
    expect(copyResultLabel(again.get('/match.html')!)).toBe(mode === 'fragment' ? 'Already uses fragment' : 'Already updated');
  });
});
