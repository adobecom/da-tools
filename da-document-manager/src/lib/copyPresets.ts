// Bulk copy edits for the Document Manager. Each preset is a find & replace scoped to one block
// element. The UI renders an Update / Rollback button pair for each: Update applies the rule (saving a
// labeled version first), Rollback restores that saved version. New copy changes are added as presets.

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
  rollbackLabel: string;
  /** Short description shown in the confirmation dialog. */
  description: string;
  update: ReplaceRule;
  /** Label for the DA version saved before a rollback overwrites the document (so it can be undone). */
  rollbackVersionLabel: string;
}

export const SHIPPING_COPY: CopyPreset = {
  id: 'MWPW-214582',
  updateLabel: 'Update shipping copy',
  rollbackLabel: 'Rollback to previous version',
  description: 'In the highlight block, "Free shipping and returns" → "Easy 30-day returns" (MWPW-214582).',
  update: {
    blockClass: 'highlight',
    element: 'h2',
    find: 'Free shipping and returns',
    replace: 'Easy 30-day returns',
    variantPattern: /free\s+shipping|shipping\s*(?:and|&)\s*returns/i,
    versionLabel: 'Before MWPW-214582 copy update',
  },
  rollbackVersionLabel: 'Before MWPW-214582 rollback',
};

export const COPY_PRESETS: CopyPreset[] = [SHIPPING_COPY];
