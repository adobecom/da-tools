# DA Document Manager

A DA (Document Authoring) tool for managing documents in a DA folder — point it at a folder, list the
documents it contains, and preview / publish / unpublish / delete them. Modeled on the **Document
Manager** tab of [pdp-document-generator](../pdp-document-generator/).

## Bulk copy edits

Select documents, then use **Update shipping copy** or **Rollback to previous version** in the bulk bar
(MWPW-214582: in the `highlight` block, "Free shipping and returns" → "Easy 30-day returns").

- **Update shipping copy**: for each document with exactly one matching heading, saves a DA version
  labeled `Before MWPW-214582 copy update` (the pre-edit content), writes the edit, and reads it back to
  verify. Other wording is reported in the **Copy** column and left alone (no version, no write).
  Re-running is safe: finished documents report "Already updated".
- **Rollback to previous version**: restores each document to its most recent
  `Before MWPW-214582 copy update` version, replacing the whole document (edits made after the update are
  discarded). A `Before MWPW-214582 rollback` version is saved first, so a rollback can itself be undone
  from DA history. Documents that already have the original copy are left alone.
- Neither button previews or publishes. Afterwards, set the **Copy** filter (e.g. "Updated" or
  "Rolled back") and the **Status** filter (e.g. "Published"), select all, then Preview / Publish.

Presets live in `src/lib/copyPresets.ts`; add a preset to get another Update / Rollback button pair.

## Stack

React 19 + TypeScript + Vite 8 + Tailwind CSS v4 — the same setup as the other Vite tools in this repo.
The DA auth token is obtained in `src/main.tsx` (from the da.live Nx Shell SDK when embedded, or
`VITE_DA_TOKEN` locally) and stored in `src/da.ts`.

## Local dev

```bash
npm install
echo "VITE_DA_TOKEN=your_token_here" > .env.local   # only needed for DA calls when run outside da.live
npm run dev      # port 3000
npm test         # Vitest: copy-edit logic
npm run build    # compiles to ./dist (commit the result)
```

Built output lives in `dist/` (committed) and is served at `/da-document-manager/dist/`. See the
repo-level [../SERVING.md](../SERVING.md) for how serving works, and [../README.md](../README.md) for the
"adding a new tool" recipe (set the Vite `base`, commit `dist/`, add a card to the root `index.html`).
