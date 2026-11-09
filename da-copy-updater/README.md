# DA Copy Updater

Makes one targeted copy change across every document in a DA folder, then previews and publishes only
the pages it changed. The current change is **MWPW-214582**: in the Print PDP `highlight` block,
`<h2>Free shipping and returns</h2>` → `<h2>Easy 30-day returns</h2>`.

Opens in DA at: **https://da.live/app/adobecom/da-tools/da-copy-updater/dist/index**

Design decisions and rationale: [PLANNING.md](./PLANNING.md).

## How to use it

Enter a DA folder (path or da.live URL), one product-type folder at a time, then work through the steps:

1. **Scan (dry run)**: reads every document and sorts it into buckets. Changes nothing.
   - *update-and-publish*: exact match, page is live, no unpublished changes.
   - *update-source-only*: exact match, page is not live (drafts, default documents).
   - *update-unpublished-changes*: exact match, page is live but was edited or previewed after its last
     publish. It gets the source edit like every other page, but is never previewed or published by
     this tool, so the author's pending changes are never pushed live.
   - *variant / no-block / no-match / ambiguous*: reported, never edited.
   - *already-updated*: the new copy is already there (re-runs are safe).
2. **Update documents**: for each document, save a DA version labeled `Before MWPW-214582 copy update`,
   replace the text, read it back to verify. Live documents edited since the scan are skipped.
3. **Preview**: skips any page edited by someone else since our update or no longer live, then
   bulk-previews the rest. **QA URLs** downloads them for spot-checks (`www.stage.adobe.com` URLs for
   `/express` pages).
4. **Publish**: re-checks each page (skips any edited, re-previewed, or unpublished by someone else since
   our update), publishes, confirms the new publish time, then **Verify live** checks the copy on `aem.live`.

**Roll back** is available any time after Update. For every document the run changed, it saves a
`Before MWPW-214582 rollback` version, then:
- unchanged since our update: restores the saved `Before MWPW-214582 copy update` version exactly, and
  re-previews / re-publishes the pages this tool had previewed / published, so the live site reverts too;
- edited by someone after our update: reverts only our heading (their edits are kept) and does not
  republish.

**Download CSV / JSON** gives the run report: per document result, reason, rollback state, timestamps,
and links, plus counts by product type. Paths outside `/drafts/` require typing the folder name to
confirm Update, Publish, and Roll back.

### Interruptions

Progress is saved in the browser (IndexedDB) as it goes. If the tab closes, the DA session expires, or
you click **Pause**, reopen the run from **Saved runs** and run the same step again; finished documents
are not redone. Keep the tab open and visible during long runs.

## Changing the copy rule

The rule lives in `src/engine/rule.ts` (`blockClass`, `element`, `find`, `replace`, `variantPattern`,
`versionLabel`). Matching is in `src/engine/classify.ts`: the DOM locates the element, and the edit is an
exact string splice on the original HTML, so nothing else in the document changes.

## Local dev

```bash
npm install
echo "VITE_DA_TOKEN=your_token_here" > .env.local   # only needed for DA calls outside da.live
npm run dev      # port 3000
npm test         # Vitest: matching rules + the full flow against an in-memory DA/AEM fake
npm run build    # compiles to ./dist (commit the result)
```

The DA/AEM helpers in `src/api/daApi.ts` and `src/lib/` are adapted from `pdp-document-generator`.
