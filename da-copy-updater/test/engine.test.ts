import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PathStatus } from '../src/api/daApi';

const base = readFileSync(resolve(__dirname, 'fixtures/highlight-row.html'), 'utf8');
const ROOT = '/adobecom/da-express-milo/drafts/test';

let clock = 1_000;
const tick = () => (clock += 1_000);
const source = new Map<string, string>();
const status = new Map<string, { source: number; preview?: number; publish?: number; previewHtml?: string; liveHtml?: string }>();
const versions: string[] = [];
const versionStore: { path: string; label: string; html: string; t: number }[] = [];
const writes: string[] = [];
let failWriteFor: string | null = null;

vi.mock('../src/api/daApi', () => ({
  crawlDocs: async () => ({
    docs: [...source.keys()].map((path) => ({ path, ext: 'html', lastModified: status.get(path)!.source })),
    errors: [],
  }),
  readSource: async (p: string) => source.get(p)!,
  writeSource: async (p: string, html: string) => {
    if (p === failWriteFor) throw new Error('write: 500');
    writes.push(p);
    source.set(p, html);
    status.get(p)!.source = tick();
  },
  createVersion: async (p: string, label: string) => {
    versions.push(p);
    versionStore.push({ path: p, label, html: source.get(p)!, t: tick() });
  },
  findVersionUrl: async (p: string, label: string) => {
    const v = versionStore.filter((x) => x.path === p && x.label === label).sort((a, b) => b.t - a.t)[0];
    return v ? `/versionsource/${versionStore.indexOf(v)}` : null;
  },
  readVersion: async (url: string) => versionStore[Number(url.split('/').pop())].html,
  bulkStatus: async (paths: string[]) => new Map<string, PathStatus>(paths.map((p) => {
    const s = status.get(p)!;
    return [p, { ok: true, sourceLastModified: s.source, previewLastModified: s.preview, publishLastModified: s.publish }];
  })),
  bulkMutate: async (topic: 'preview' | 'live', paths: string[]) => {
    for (const p of paths) {
      const s = status.get(p)!;
      if (topic === 'preview') { s.preview = tick(); s.previewHtml = source.get(p); }
      else { s.publish = tick(); s.liveHtml = s.previewHtml; }
    }
  },
  fetchLivePlain: async (p: string) => status.get(p)?.liveHtml ?? null,
}));

const { scan, applyUpdates, previewUpdated, publishPreviewed, verifyLive, rollback, eligibleFor } = await import('../src/engine/run');
const { PRINT_PDP_RETURNS_RULE: RULE } = await import('../src/engine/rule');
const { resultFor } = await import('../src/engine/model');
type DocRecord = import('../src/engine/model').DocRecord;

function addDoc(name: string, html: string, state: 'live' | 'draft' | 'live-with-edits') {
  const path = `${ROOT}/card/${name}.html`;
  source.set(path, html);
  const s = { source: tick(), preview: undefined as number | undefined, publish: undefined as number | undefined, previewHtml: html, liveHtml: html };
  if (state !== 'draft') { s.preview = tick(); s.publish = tick(); }
  if (state === 'live-with-edits') s.source = tick();
  status.set(path, s);
  return path;
}

function ctxFor(records: DocRecord[]) {
  const journal = { put: vi.fn(), putNow: vi.fn(async () => {}) };
  return {
    rule: RULE,
    root: ROOT,
    records: new Map(records.map((r) => [r.path, r])),
    journal: journal as never,
    signal: new AbortController().signal,
    emit: () => {},
  };
}

beforeEach(() => {
  source.clear(); status.clear(); versions.length = 0; versionStore.length = 0; writes.length = 0; failWriteFor = null;
});

describe('engine end to end (fake DA/AEM)', () => {
  it('updates, previews, publishes and verifies only safe pages', async () => {
    const live = addDoc('live', base, 'live');
    const draft = addDoc('draft', base, 'draft');
    const edited = addDoc('edited', base, 'live-with-edits');
    const variant = addDoc('variant', base.replace('Free shipping and returns', 'Free shipping &amp; returns'), 'live');

    const records = await scan(ROOT, RULE, new AbortController().signal, () => {});
    const by = (p: string) => records.find((r) => r.path === p)!;
    expect(by(live).bucket).toBe('update-and-publish');
    expect(by(draft).bucket).toBe('update-source-only');
    expect(by(edited).bucket).toBe('update-unpublished-changes');
    expect(by(variant).bucket).toBe('variant');
    expect(writes).toHaveLength(0);

    const ctx = ctxFor(records);
    await applyUpdates(ctx);
    expect(writes.sort()).toEqual([draft, edited, live].sort());
    expect(versions.sort()).toEqual([draft, edited, live].sort());
    expect(source.get(edited)).toContain('Easy 30-day returns');
    const editedPublishBefore = status.get(edited)!.publish;
    const editedPreviewBefore = status.get(edited)!.preview;

    await previewUpdated(ctx);
    await publishPreviewed(ctx);
    await verifyLive(ctx);

    expect(resultFor(by(live))).toBe('published');
    expect(by(live).liveVerified).toBe(true);
    expect(resultFor(by(draft))).toBe('updated (not live)');
    expect(status.get(draft)!.publish).toBeUndefined();
    expect(resultFor(by(edited))).toBe('updated (not published: had unpublished changes)');
    expect(status.get(edited)!.publish).toBe(editedPublishBefore);
    expect(status.get(edited)!.preview).toBe(editedPreviewBefore);
    expect(resultFor(by(variant))).toBe('variant');
  });

  it('skips a page edited between scan and apply', async () => {
    const p = addDoc('a', base, 'live');
    const records = await scan(ROOT, RULE, new AbortController().signal, () => {});
    source.set(p, base.replace('Yellow Technology', 'Yellow Tech'));
    await applyUpdates(ctxFor(records));
    expect(writes).toHaveLength(0);
    expect(records[0].stage).toBe('skipped');
  });

  it('keeps a failed write retryable, then succeeds on retry', async () => {
    const p = addDoc('a', base, 'live');
    const records = await scan(ROOT, RULE, new AbortController().signal, () => {});
    const ctx = ctxFor(records);
    failWriteFor = p;
    await applyUpdates(ctx);
    expect(resultFor(records[0])).toBe('failed (update)');
    failWriteFor = null;
    await applyUpdates(ctx);
    expect(records[0].stage).toBe('updated');
    expect(records[0].error).toBeUndefined();
  });

  it('recognizes a write that landed before an interruption', async () => {
    const p = addDoc('a', base, 'live');
    const records = await scan(ROOT, RULE, new AbortController().signal, () => {});
    const ctx = ctxFor(records);
    await applyUpdates(ctx);
    records[0].stage = 'scanned';
    writes.length = 0;
    await applyUpdates(ctx);
    expect(writes).toHaveLength(0);
    expect(records[0].stage).toBe('updated');
    expect(source.get(p)).toContain('Easy 30-day returns');
  });

  it('does not preview or publish a page edited between update and preview', async () => {
    const p = addDoc('a', base, 'live');
    const records = await scan(ROOT, RULE, new AbortController().signal, () => {});
    const ctx = ctxFor(records);
    await applyUpdates(ctx);
    source.set(p, source.get(p)!.replace('Yellow Technology', 'Unreviewed edit'));
    status.get(p)!.source = tick();
    const previewBefore = status.get(p)!.preview;
    await previewUpdated(ctx);
    await publishPreviewed(ctx);
    expect(records[0].stage).toBe('skipped');
    expect(records[0].skipReason).toMatch(/Edited by someone else/);
    expect(status.get(p)!.preview).toBe(previewBefore);
  });

  it('does not republish a page unpublished after the scan', async () => {
    const p = addDoc('a', base, 'live');
    const records = await scan(ROOT, RULE, new AbortController().signal, () => {});
    const ctx = ctxFor(records);
    await applyUpdates(ctx);
    status.get(p)!.publish = undefined;
    await previewUpdated(ctx);
    await publishPreviewed(ctx);
    expect(records[0].stage).toBe('skipped');
    expect(records[0].skipReason).toMatch(/No longer live/);
    expect(status.get(p)!.publish).toBeUndefined();
  });

  it('does not publish a page edited after our preview', async () => {
    const p = addDoc('a', base, 'live');
    const records = await scan(ROOT, RULE, new AbortController().signal, () => {});
    const ctx = ctxFor(records);
    await applyUpdates(ctx);
    await previewUpdated(ctx);
    status.get(p)!.source = tick();
    const publishedBefore = status.get(p)!.publish;
    await publishPreviewed(ctx);
    expect(records[0].stage).toBe('skipped');
    expect(status.get(p)!.publish).toBe(publishedBefore);
  });
});

describe('rollback (fake DA/AEM)', () => {
  async function runForward() {
    const live = addDoc('live', base, 'live');
    const draft = addDoc('draft', base, 'draft');
    const records = await scan(ROOT, RULE, new AbortController().signal, () => {});
    const ctx = ctxFor(records);
    await applyUpdates(ctx);
    return { live, draft, records, ctx, by: (p: string) => records.find((r) => r.path === p)! };
  }

  it('restores the saved version and re-publishes pages we published', async () => {
    const { live, draft, ctx, by } = await runForward();
    await previewUpdated(ctx);
    await publishPreviewed(ctx);
    const publishedAt = status.get(live)!.publish!;
    expect(status.get(live)!.liveHtml).toContain('Easy 30-day returns');

    await rollback(ctx);

    expect(source.get(live)).toBe(base);
    expect(source.get(draft)).toBe(base);
    expect(status.get(live)!.publish!).toBeGreaterThan(publishedAt);
    expect(status.get(live)!.liveHtml).toBe(base);
    expect(status.get(draft)!.publish).toBeUndefined();
    expect(resultFor(by(live))).toBe('rolled back');
    expect(by(live).rollbackMethod).toBe('version');
    expect(versionStore.filter((v) => v.label === RULE.rollbackVersionLabel)).toHaveLength(2);
    expect(eligibleFor('rollback', ctx.records.values())).toHaveLength(0);
  });

  it('reverts only the copy on a page edited after our update, and does not republish it', async () => {
    const { live, ctx, by } = await runForward();
    await previewUpdated(ctx);
    await publishPreviewed(ctx);
    const edited = source.get(live)!.replace('Yellow Technology', 'Author edit');
    source.set(live, edited);
    const publishedAt = status.get(live)!.publish;

    await rollback(ctx);

    expect(source.get(live)).toBe(edited.replace('Easy 30-day returns', 'Free shipping and returns'));
    expect(status.get(live)!.publish).toBe(publishedAt);
    expect(resultFor(by(live))).toBe('rolled back (source only)');
  });

  it('reverts a publish that ran but was interrupted before it was confirmed', async () => {
    const { live, ctx, by } = await runForward();
    await previewUpdated(ctx);
    const { bulkMutate } = await import('../src/api/daApi');
    await bulkMutate('live', [live]);
    expect(by(live).stage).toBe('previewed');
    expect(status.get(live)!.liveHtml).toContain('Easy 30-day returns');

    await rollback(ctx);

    expect(status.get(live)!.liveHtml).toBe(base);
    expect(resultFor(by(live))).toBe('rolled back');
  });

  it('clears a stale rollback error when a retry ends source-only', async () => {
    const { live, ctx, by } = await runForward();
    await previewUpdated(ctx);
    await publishPreviewed(ctx);
    await rollback(ctx);
    by(live).rollbackStage = 'previewed';
    by(live).rollbackError = 'Publish status unknown; run Roll back again';
    status.get(live)!.publish = undefined;
    await rollback(ctx);
    expect(by(live).rollbackError).toBeUndefined();
    expect(resultFor(by(live))).toBe('rolled back (source only)');
  });

  it('works right after Update (before preview/publish)', async () => {
    const { live, ctx, by } = await runForward();
    const previewBefore = status.get(live)!.preview;
    await rollback(ctx);
    expect(source.get(live)).toBe(base);
    expect(status.get(live)!.preview).toBe(previewBefore);
    expect(resultFor(by(live))).toBe('rolled back');
  });

  it('excludes rolled-back documents from forward steps', async () => {
    const { ctx } = await runForward();
    await rollback(ctx);
    expect(eligibleFor('preview', ctx.records.values())).toHaveLength(0);
    expect(eligibleFor('apply', ctx.records.values())).toHaveLength(0);
  });
});
