// Ported from da-copy-updater/src/engine/classify.ts (keep the two in sync).
import type { ReplaceRule } from './copyPresets';

export type ClassifyOutcome = 'match' | 'already-updated' | 'variant' | 'no-block' | 'no-match' | 'ambiguous';

export interface ClassifyResult {
  outcome: ClassifyOutcome;
  /** Text found in the block when it isn't an exact match (variants, ambiguous matches). */
  detail?: string;
  /** Updated HTML; only set when outcome is `match`. */
  newHtml?: string;
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function targetElements(doc: Document, rule: ReplaceRule): { blocks: Element[]; els: Element[] } {
  const blocks = [...doc.querySelectorAll(`div[class~="${rule.blockClass.replace(/["\\]/g, '')}"]`)];
  return { blocks, els: blocks.flatMap((b) => [...b.querySelectorAll(rule.element)]) };
}

/** Confirms the spliced HTML changed the located element itself, not a look-alike elsewhere. */
function editLandedInBlock(newHtml: string, rule: ReplaceRule, index: number, count: number): boolean {
  const { els } = targetElements(new DOMParser().parseFromString(newHtml, 'text/html'), rule);
  return els.length === count && norm(els[index]?.textContent) === rule.replace;
}

/**
 * Decide what to do with one document. The DOM is used only to *locate* the target; the edit itself
 * is an exact string splice on the original HTML, so nothing else in the document is re-serialized.
 */
export function classify(html: string, rule: ReplaceRule): ClassifyResult {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const { blocks, els } = targetElements(doc, rule);
  if (blocks.length === 0) return { outcome: 'no-block' };

  const exact = els.filter((el) => norm(el.textContent) === rule.find);
  const tag = escapeRegExp(rule.element);
  const rawPattern = new RegExp(`<${tag}(\\s[^>]*)?>${escapeRegExp(escapeHtml(rule.find))}</${tag}>`, 'g');
  const rawMatches = [...html.matchAll(rawPattern)];

  if (exact.length > 1 || rawMatches.length > 1) {
    return { outcome: 'ambiguous', detail: `${Math.max(exact.length, rawMatches.length)} matches` };
  }
  if (exact.length === 1 && (rawMatches.length === 0 || exact[0].innerHTML !== escapeHtml(rule.find))) {
    return { outcome: 'variant', detail: `Text matches but markup differs: ${exact[0].outerHTML.slice(0, 200)}` };
  }
  if (exact.length === 0 && rawMatches.length === 1) {
    return { outcome: 'ambiguous', detail: 'Text found outside the target block' };
  }
  if (exact.length === 1 && rawMatches.length === 1) {
    const m = rawMatches[0];
    const before = m[0];
    const after = `<${rule.element}${m[1] ?? ''}>${escapeHtml(rule.replace)}</${rule.element}>`;
    const newHtml = html.slice(0, m.index) + after + html.slice(m.index + before.length);
    const okLength = newHtml.length - html.length === after.length - before.length;
    if (!okLength || newHtml.includes(before) || !editLandedInBlock(newHtml, rule, els.indexOf(exact[0]), els.length)) {
      return { outcome: 'ambiguous', detail: 'Post-edit check failed' };
    }
    return { outcome: 'match', newHtml };
  }

  if (els.some((el) => norm(el.textContent) === rule.replace)) return { outcome: 'already-updated' };

  const leafTexts = blocks
    .flatMap((b) => [...b.querySelectorAll('*')])
    .filter((el) => el.children.length === 0)
    .map((el) => ({ tag: el.tagName.toLowerCase(), text: norm(el.textContent) }));
  const variant = leafTexts.find((t) => rule.variantPattern.test(t.text));
  if (variant) return { outcome: 'variant', detail: `<${variant.tag}> ${variant.text}` };

  return { outcome: 'no-match' };
}
