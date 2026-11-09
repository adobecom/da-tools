// Bulk copy edits for the Document Manager. Each preset is a find & replace scoped to one block
// element, with an explicit reverse rule so the same edit can be undone. New copy changes are added
// here as presets; the UI renders an Update / Revert button pair for each.

export interface ReplaceRule {
  /** Class of the block whose rows are searched (e.g. `highlight` matches `<div class="highlight">`). */
  blockClass: string;
  /** Element inside the block that carries the text. */
  element: string;
  find: string;
  replace: string;
  /** Loose pattern for reworded versions of `find`; matches are reported, never edited. */
  variantPattern: RegExp;
  /** Label for the DA version saved before each write (the restore point). */
  versionLabel: string;
}

export interface CopyPreset {
  id: string;
  updateLabel: string;
  revertLabel: string;
  /** Short description shown in the confirmation dialog. */
  description: string;
  update: ReplaceRule;
  revert: ReplaceRule;
}

export const SHIPPING_COPY: CopyPreset = {
  id: 'MWPW-214582',
  updateLabel: 'Update shipping copy',
  revertLabel: 'Revert shipping copy',
  description: 'In the highlight block, "Free shipping and returns" → "Easy 30-day returns" (MWPW-214582).',
  update: {
    blockClass: 'highlight',
    element: 'h2',
    find: 'Free shipping and returns',
    replace: 'Easy 30-day returns',
    variantPattern: /free\s+shipping|shipping\s*(?:and|&)\s*returns/i,
    versionLabel: 'Before MWPW-214582 copy update',
  },
  revert: {
    blockClass: 'highlight',
    element: 'h2',
    find: 'Easy 30-day returns',
    replace: 'Free shipping and returns',
    variantPattern: /30[\s-]*day\s+returns/i,
    versionLabel: 'Before MWPW-214582 copy revert',
  },
};

export const COPY_PRESETS: CopyPreset[] = [SHIPPING_COPY];
