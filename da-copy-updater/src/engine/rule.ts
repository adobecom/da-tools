export interface ReplaceRule {
  id: string;
  title: string;
  /** Class of the block whose rows are searched (e.g. `highlight` matches `<div class="highlight">`). */
  blockClass: string;
  /** Element inside the block that carries the text. */
  element: string;
  find: string;
  replace: string;
  /** Loose pattern for reworded versions of `find`; matches are reported, never edited. */
  variantPattern: RegExp;
  /** Label for the DA version saved before each write (the rollback point). */
  versionLabel: string;
  /** Label for the DA version saved before a rollback overwrites the document. */
  rollbackVersionLabel: string;
  ticketUrl?: string;
}

export const PRINT_PDP_RETURNS_RULE: ReplaceRule = {
  id: 'MWPW-214582',
  title: 'Print PDP highlight: "Free shipping and returns" → "Easy 30-day returns"',
  blockClass: 'highlight',
  element: 'h2',
  find: 'Free shipping and returns',
  replace: 'Easy 30-day returns',
  variantPattern: /free\s+shipping|shipping\s*(?:and|&)\s*returns/i,
  versionLabel: 'Before MWPW-214582 copy update',
  rollbackVersionLabel: 'Before MWPW-214582 rollback',
  ticketUrl: 'https://jira.corp.adobe.com/browse/MWPW-214582',
};
