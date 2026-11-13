# DA Document Manager

A DA (Document Authoring) tool for managing documents in a DA folder — point it at a folder, list the
documents it contains, and preview / publish / unpublish / delete them. Modeled on the **Document
Manager** tab of [pdp-document-generator](../pdp-document-generator/).

## Bulk copy edits

Select documents, then use **Update shipping copy** or **Rollback to previous version** in the bulk bar
(MWPW-214582).

- **Dry run** reads the selected documents and shows, in the **Copy** column, counters, and activity log,
  what Update would do (in the mode set by the fragment checkbox): "Would update" / "Would replace with
  fragment", "Already updated", "Different wording", "No matching block", etc. Nothing is written. To
  update exactly the predicted set, set the Copy filter to "Would update", select all, then Update.

- **Update shipping copy** has two modes:
  - *Text (default)*: in the `highlight` block, replaces "Free shipping and returns" with
    "Easy 30-day returns". Only an exact single match is edited.
  - *Use fragment instead* (checkbox): replaces the whole `highlight` block with a `fragment` block linking
    to `/express/fragments/print-product-detail/highlight-ribbon`, so future copy changes are one edit to
    the fragment. Only a block named exactly `highlight` that contains the shipping row is replaced (a block
    that merely uses `highlight` as a variant, like `steps highlight`, is never touched). The confirmation
    checks the fragment is published; publish it before publishing swapped pages.

  Either way, a labeled DA version (`Before MWPW-214582 copy update` / `… fragment swap`) is saved right
  before each change and the document is read back to verify. Anything else is reported in the **Copy**
  column and left alone. Re-running is safe.
- **Rollback to previous version** restores the version saved right before the most recent update (either
  mode), replacing the whole document; edits made after that update are discarded. A
  `Before MWPW-214582 rollback` version is saved first. Running it again steps back one more update.
- Neither button previews or publishes. Afterwards, set the **Copy** and **Status** filters, select all,
  then Preview / Publish.
- **Download report** (CSV or JSON) exports the rows currently shown, with each document's status, copy
  result, details, and links; the JSON adds counts by copy result, status, and folder.

Presets live in `src/lib/copyPresets.ts`; add a preset to get another Update / Rollback button pair.

## Progress and activity log

Every long operation (scan, status refresh, batch load, Preview / Publish / Unpublish / Delete, Update /
Rollback) shows a progress bar with elapsed time and an estimate. Update / Rollback also show live counts
(changed, already done, skipped for wording / missing copy, failed). The **Activity log** below the bar
records each operation's start and outcome, plus one line per skipped or failed document with the
reason; it can be downloaded or cleared.

## Stack

React 19 + TypeScript + Vite 8 + Tailwind CSS v4 — the same setup as the other Vite tools in this repo.
The DA auth token is obtained in `src/main.tsx` (from the da.live Nx Shell SDK when embedded, or
`VITE_DA_TOKEN` locally) and stored in `src/da.ts`.

## Local dev

```bash
npm install
echo "VITE_DA_TOKEN=your_token_here" > .env.local   # only needed for DA calls when run outside da.live
npm run dev      # port 3000
npm test         # Vitest: copy edits, fragment swap, report, activity UI
npm run build    # compiles to ./dist (commit the result)
```

Built output lives in `dist/` (committed) and is served at `/da-document-manager/dist/`. See the
repo-level [../SERVING.md](../SERVING.md) for how serving works, and [../README.md](../README.md) for the
"adding a new tool" recipe (set the Vite `base`, commit `dist/`, add a card to the root `index.html`).
