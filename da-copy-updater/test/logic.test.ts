import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/engine/classify';
import { bucketForMatch, hashText, productTypeFor, resultFor, type DocRecord } from '../src/engine/model';
import { isDraftsRoot, normalizeRoot } from '../src/engine/paths';
import { PRINT_PDP_RETURNS_RULE as RULE } from '../src/engine/rule';

const base = readFileSync(resolve(__dirname, 'fixtures/highlight-row.html'), 'utf8');
const OLD = '<h2>Free shipping and returns</h2>';
const NEW = '<h2>Easy 30-day returns</h2>';

describe('classify', () => {
  it('replaces exactly the highlight row and nothing else', () => {
    const r = classify(base, RULE);
    expect(r.outcome).toBe('match');
    expect(r.newHtml).toBe(base.replace(OLD, NEW));
    expect(r.newHtml).toContain('We currently support shipping within the US');
  });

  it('handles a default document with {{placeholders}}', () => {
    const tpl = base.replace('urn:aaid:sc:VA6C2:8b881ffb-9349-58f8-8002-1c32eef3d313', '{{product_id}}');
    expect(classify(tpl, RULE).newHtml).toBe(tpl.replace(OLD, NEW));
  });

  it('keeps attributes on the heading', () => {
    const html = base.replace(OLD, '<h2 id="free-shipping-and-returns">Free shipping and returns</h2>');
    expect(classify(html, RULE).newHtml).toContain('<h2 id="free-shipping-and-returns">Easy 30-day returns</h2>');
  });

  it('is idempotent: an updated document reads as already-updated', () => {
    const updated = classify(base, RULE).newHtml!;
    expect(classify(updated, RULE).outcome).toBe('already-updated');
  });

  it.each([
    ['ampersand', '<h2>Free shipping &amp; returns</h2>'],
    ['different case', '<h2>Free Shipping and Returns</h2>'],
    ['paragraph instead of heading', '<p>Free shipping and returns</p>'],
    ['extra words', '<h2>Free shipping and returns on all orders</h2>'],
  ])('reports a variant (%s) without editing', (_name, row) => {
    const r = classify(base.replace(OLD, row), RULE);
    expect(r.outcome).toBe('variant');
    expect(r.newHtml).toBeUndefined();
    expect(r.detail).toBeTruthy();
  });

  it('reports a variant when the text is wrapped in extra markup', () => {
    const r = classify(base.replace(OLD, '<h2><strong>Free shipping and returns</strong></h2>'), RULE);
    expect(r.outcome).toBe('variant');
  });

  it('never edits a look-alike heading outside the block', () => {
    const html = base
      .replace(OLD, '<h2><strong>Free shipping and returns</strong></h2>')
      .replace('<footer></footer>', `<footer><div class="banner">${OLD}</div></footer>`);
    const r = classify(html, RULE);
    expect(r.outcome).not.toBe('match');
    expect(r.newHtml).toBeUndefined();
  });

  it('reports no-block when the highlight block is missing', () => {
    expect(classify(base.replace('class="highlight"', 'class="something-else"'), RULE).outcome).toBe('no-block');
  });

  it('reports no-match when the block has no shipping row', () => {
    expect(classify(base.replace(OLD, '<h2>Fast delivery</h2>'), RULE).outcome).toBe('no-match');
  });

  it('reports ambiguous for duplicate rows', () => {
    expect(classify(base.replace(OLD, OLD + OLD), RULE).outcome).toBe('ambiguous');
  });

  it('reports ambiguous when the text also appears outside the block', () => {
    const html = base.replace('<footer></footer>', `<footer>${OLD}</footer>`);
    expect(classify(html, RULE).outcome).toBe('ambiguous');
  });

  it('matches a block with variant classes', () => {
    expect(classify(base.replace('class="highlight"', 'class="highlight dark"'), RULE).outcome).toBe('match');
  });
});

describe('bucketForMatch', () => {
  const t = (iso: string) => Date.parse(iso);

  it('updates and publishes a live page with no pending changes', () => {
    expect(bucketForMatch({ ok: true, sourceLastModified: t('2026-09-30T17:28:00Z'), previewLastModified: t('2026-10-01T00:00:00Z'), publishLastModified: t('2026-10-01T00:01:00Z') }))
      .toBe('update-and-publish');
  });

  it('skips a live page edited after its last publish', () => {
    expect(bucketForMatch({ ok: true, sourceLastModified: t('2026-10-02T00:00:00Z'), previewLastModified: t('2026-10-01T00:00:00Z'), publishLastModified: t('2026-10-01T00:01:00Z') }))
      .toBe('skip-unpublished-changes');
  });

  it('skips a live page previewed after its last publish', () => {
    expect(bucketForMatch({ ok: true, sourceLastModified: t('2026-09-30T00:00:00Z'), previewLastModified: t('2026-10-02T00:00:00Z'), publishLastModified: t('2026-10-01T00:01:00Z') }))
      .toBe('skip-unpublished-changes');
  });

  it('falls back to the DA list timestamp when the job has no source time', () => {
    expect(bucketForMatch({ ok: true, publishLastModified: t('2026-10-01T00:00:00Z') }, t('2026-10-05T00:00:00Z')))
      .toBe('skip-unpublished-changes');
  });

  it('only edits the source of a page that is not live', () => {
    expect(bucketForMatch({ ok: true, sourceLastModified: 1, previewLastModified: 2 })).toBe('update-source-only');
  });

  it('skips when status is unknown', () => {
    expect(bucketForMatch({ ok: false })).toBe('skip-status-unknown');
    expect(bucketForMatch(undefined)).toBe('skip-status-unknown');
  });
});

describe('helpers', () => {
  it('normalizes folder inputs', () => {
    const want = '/adobecom/da-express-milo/drafts/maxn/document-generator';
    expect(normalizeRoot('https://da.live/#/adobecom/da-express-milo/drafts/maxn/document-generator')).toBe(want);
    expect(normalizeRoot('adobecom/da-express-milo/drafts/maxn/document-generator/')).toBe(want);
    expect(normalizeRoot(` ${want} `)).toBe(want);
    expect(() => normalizeRoot('/adobecom/da-express-milo')).toThrow();
  });

  it('detects drafts roots', () => {
    expect(isDraftsRoot('/adobecom/da-express-milo/drafts/maxn')).toBe(true);
    expect(isDraftsRoot('/adobecom/da-express-milo/express/print/card')).toBe(false);
  });

  it('derives product type from the first folder under the root', () => {
    const root = '/adobecom/da-express-milo/drafts/maxn/document-generator';
    expect(productTypeFor(`${root}/card/foo.html`, root)).toBe('card');
    expect(productTypeFor('/adobecom/da-express-milo/express/print/card/foo.html', '/adobecom/da-express-milo/express/print/card')).toBe('card');
  });

  it('hashes differ when content differs', () => {
    expect(hashText(base)).toBe(hashText(`${base}`));
    expect(hashText(base)).not.toBe(hashText(base.replace(OLD, NEW)));
  });

  it('describes results', () => {
    const rec: DocRecord = { path: '/a/b/c.html', productType: 'c', bucket: 'update-and-publish', stage: 'previewed' };
    expect(resultFor(rec)).toBe('previewed, pending publish');
    expect(resultFor({ ...rec, error: 'x' })).toBe('failed (publish)');
    expect(resultFor({ ...rec, bucket: 'update-source-only', stage: 'updated' })).toBe('updated (source only)');
    expect(resultFor({ ...rec, bucket: 'variant', stage: 'scanned' })).toBe('variant');
  });
});
