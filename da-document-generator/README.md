# DA Document Generator

A generic DA tool: fill a template document's `{{placeholder}}` tokens from a spreadsheet (CSV/XLSX) or JSON file and write the resulting documents to DA. A more general sibling of the [pdp-document-generator](../pdp-document-generator/), with the product-specific logic stripped out.

Opens in DA at: **https://da.live/app/adobecom/da-tools/da-document-generator/dist/index**

## What it does

1. **Data** — upload a CSV/XLSX/JSON file (JSON may be an array of objects or a DA sheet `{ "data": [...] }`). Each column becomes a `{{column}}` token; pick which rows to generate.
2. **Template & target** — point at a DA template document (path or URL). The tool fetches it, lists its `{{tokens}}`, and flags any token with no matching data column. Choose the output directory and the data column that names each document.
3. **Generate** — writes one document per selected row (versioning any existing doc first), then preview / publish per row or in bulk.

## What gets written

Each generated document is the template with its `{{tokens}}` filled in from the row — nothing else from your data is added:

- **`{{token}}` substitution** — every `{{column}}` in the template is replaced with that row's value: in the body, in link URLs (e.g. set a link's URL to `{{marquee-cta-link}}`), and in the template's own Metadata block. Columns the template doesn't reference are ignored, and nothing else in the template is rewritten.
- **Metadata** — the template's Metadata block is kept as authored (with its `{{tokens}}` filled). The tool adds only `generated-batch` (one shared ISO timestamp per Generate run) and `last-updated` (per doc), creating a Metadata block if the template has none. To put a data value into page metadata (e.g. `title`, `description`, `sheet-powered`), add a `key | {{column}}` row to the template's Metadata block.

Documents are fully baked at generation time — they don't rely on the site's runtime `content-replace.js` to fill tokens.

## Local dev

```bash
npm install
echo "VITE_DA_TOKEN=your_token_here" > .env.local   # needed for DA calls when run outside da.live
npm run dev      # port 3000
npm run build    # compiles to ./dist (commit the result)
```

Built output lives in `dist/` (committed) and is served at `/da-document-generator/dist/`. See the repo-level [../SERVING.md](../SERVING.md) for how serving works.

## Reuse

The DA API layer (`src/api/daApi.ts`), metadata-block builder (`src/lib/metadata.ts`), `applyTemplate` (`src/lib/generate.ts`), concurrency helper, token bootstrap, action hooks, and status pills are copied from `pdp-document-generator`. The tool-specific logic lives in `src/lib/buildDoc.ts` (the document builder + output-path resolution + QA) and `src/components/`.
