// Bulk copy edits for the Document Manager. Each preset is a find & replace scoped to one block
// element, optionally with an alternative "fragment swap" mode that replaces the whole block with a
// fragment reference. The UI renders an Update / Rollback button pair for each: Update applies the
// change (saving a labeled version first), Rollback restores the most recent saved version.

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

/** Alternative Update mode: replace the whole block with a `fragment` block linking to a shared fragment. */
export interface FragmentSwap {
  /** Block name (first class) to replace, e.g. `highlight` (not `steps highlight`, where it's a variant). */
  blockName: string;
  /** Link written into the `fragment` block. */
  fragmentUrl: string;
  /** DA path of the fragment, for linking to it in the UI. */
  fragmentDaPath: string;
  /** The block is only replaced if its text contains one of these, proving it's the expected block. */
  mustContain: string[];
  /** Label for the DA version saved before each swap. */
  versionLabel: string;
  /** Checkbox label in the bulk bar. */
  optionLabel: string;
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
  fragment?: FragmentSwap;
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
  fragment: {
    blockName: 'highlight',
    fragmentUrl: 'https://main--da-express-milo--adobecom.aem.live/express/fragments/print-product-detail/highlight-ribbon',
    fragmentDaPath: '/adobecom/da-express-milo/express/fragments/print-product-detail/highlight-ribbon',
    mustContain: ['Free shipping and returns', 'Easy 30-day returns'],
    versionLabel: 'Before MWPW-214582 fragment swap',
    optionLabel: 'Replace the whole highlight block with the highlight-ribbon fragment',
  },
};

export const COPY_PRESETS: CopyPreset[] = [SHIPPING_COPY];
