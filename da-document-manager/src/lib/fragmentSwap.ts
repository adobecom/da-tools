import type { FragmentSwap } from './copyPresets';

export type SwapOutcome = 'match' | 'already-swapped' | 'no-block' | 'no-match' | 'ambiguous';

export interface SwapResult {
  outcome: SwapOutcome;
  detail?: string;
  /** Updated HTML; only set when outcome is `match`. */
  newHtml?: string;
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Blocks whose name (first class) is exactly `name`, e.g. `highlight` but not `steps highlight`. */
function blocksNamed(doc: Document, name: string): Element[] {
  return [...doc.querySelectorAll('div[class]')].filter((el) => el.classList[0] === name);
}

function fragmentPath(url: string): string {
  try {
    return new URL(url).pathname.replace(/\.html$/, '').replace(/\/$/, '');
  } catch {
    return url;
  }
}

function hasFragmentLink(doc: Document, swap: FragmentSwap): boolean {
  const want = fragmentPath(swap.fragmentUrl);
  return [...doc.querySelectorAll('div.fragment a[href]')]
    .some((a) => fragmentPath(a.getAttribute('href') ?? '') === want);
}

export function fragmentBlockHtml(url: string): string {
  return `<div class="fragment"><div><div><p><a href="${url}">${url}</a></p></div></div></div>`;
}

/** End index (exclusive) of the `<div>` element that opens at `start`, by counting nested divs. */
function divEnd(html: string, start: number): number {
  const re = /<div\b[^>]*>|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/**
 * Decide whether to replace the document's `swap.blockName` block with a fragment block. The DOM
 * locates and validates the block; the edit is a string splice on the original HTML, so the rest of
 * the document is byte-for-byte unchanged (checked again by re-parsing the result).
 */
export function classifyFragmentSwap(html: string, swap: FragmentSwap): SwapResult {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = blocksNamed(doc, swap.blockName);
  if (blocks.length === 0) {
    return hasFragmentLink(doc, swap) ? { outcome: 'already-swapped' } : { outcome: 'no-block' };
  }
  if (blocks.length > 1) return { outcome: 'ambiguous', detail: `${blocks.length} ${swap.blockName} blocks` };
  const blockText = norm(blocks[0].textContent);
  if (!swap.mustContain.some((t) => blockText.includes(t))) {
    return { outcome: 'no-match', detail: `The ${swap.blockName} block doesn't contain the expected row` };
  }

  const opening = new RegExp(`<div class="${escapeRegExp(swap.blockName)}(?:\\s[^"]*)?"[^>]*>`, 'g');
  const openings = [...html.matchAll(opening)];
  if (openings.length !== 1) return { outcome: 'ambiguous', detail: 'Block markup could not be located exactly' };
  const start = openings[0].index;
  const end = divEnd(html, start);
  if (end < 0) return { outcome: 'ambiguous', detail: 'Block markup is not well formed' };

  const newHtml = html.slice(0, start) + fragmentBlockHtml(swap.fragmentUrl) + html.slice(end);

  const after = new DOMParser().parseFromString(newHtml, 'text/html');
  const beforeText = norm(norm(doc.body.textContent).replace(blockText, ''));
  const afterText = norm(norm(after.body.textContent).replace(swap.fragmentUrl, ''));
  if (blocksNamed(after, swap.blockName).length !== 0 || !hasFragmentLink(after, swap) || beforeText !== afterText) {
    return { outcome: 'ambiguous', detail: 'Post-edit check failed' };
  }
  return { outcome: 'match', newHtml };
}
