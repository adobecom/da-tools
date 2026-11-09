# DA Document Manager

A DA (Document Authoring) tool for managing documents in a DA folder — point it at a folder, list the
documents it contains, and preview / publish / unpublish / delete them. Modeled on the **Document
Manager** tab of [pdp-document-generator](../pdp-document-generator/).

## Bulk copy edits

Select documents, then use **Update shipping copy** / **Revert shipping copy** in the bulk bar
(MWPW-214582: in the `highlight` block, "Free shipping and returns" ↔ "Easy 30-day returns").

- Only an exact single match is edited; other wording is reported in the **Copy** column and left alone.
- A DA version (`Before MWPW-214582 copy update` / `… copy revert`) is saved before each change, and
  each document is read back to verify. Re-running is safe: finished documents report "Already updated".
- Nothing is previewed or published. Afterwards, use the **Copy** filter (e.g. "Updated"), select all,
  and Preview / Publish as usual.
- Revert swaps the text back, keeping any other edits made since.

Presets live in `src/lib/copyPresets.ts`; add a preset to get another Update / Revert button pair.

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
