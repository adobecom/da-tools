# da-document-studio — Project Handoff

A living handoff for anyone (human or agent) picking up **da-document-studio**. It explains what the
tool is, why it exists, its current state, and the concrete next steps. **Read this first — then read
`da-document-manager/PLANNING.md`, which is the design spec that governs the Manager half.**

> **Bottom line:** da-document-studio is currently a **milestone-1 scaffold** — a two-tab shell plus a
> DA token handshake, with placeholder tab bodies. The real generator and manager logic it will
> combine does **not** live here yet; it lives in the sibling tools and is what you'll port.

---

## 1. What it is

A combined DA (Document Authoring) **"Document Studio"** that puts a document **Generator** and a
document **Manager** behind one two-tab shell, served at:

> https://da.live/app/adobecom/da-tools/da-document-studio/dist/index

From `vite.config.ts`: *"a combined DA document generator + document manager behind a two-tab shell."*

### What "combined" means
It unifies the two existing standalone tools in this repo:
- **`da-document-generator/`** — fill a template document's `{{placeholder}}` tokens from a spreadsheet
  (CSV/XLSX) or JSON file and write the resulting documents to DA.
- **`da-document-manager/`** — point at a DA folder, list its documents, and preview / publish /
  unpublish / delete them (individually or in bulk).

### Origin / why it exists
Lineage: **`pdp-document-generator`** (product-specific: Zazzle/GMC, already a two-tab Generate +
Document Manager app) → was split into the generic **`da-document-generator`** + **`da-document-manager`**
→ now being **re-unified** as the generic **`da-document-studio`**.

Why combine (legible from `src/App.tsx` comments, not a separate doc):
1. **One workflow** — generate documents and immediately manage/publish them in the same session
   against the same in-memory set, instead of round-tripping between two apps. The tabs are both kept
   mounted so *"each tab's state survives switches and the Document Manager can pre-warm its scan"*, and
   there's a planned **"generate → manage handoff in milestone 4."**
2. **De-duplicate** — the DA API / metadata / concurrency / actions code is currently **copy-pasted**
   across three tools and has already drifted. Studio's M2 goal is to consolidate it into one merged
   layer.

There is **no studio-specific README/PLANNING/design doc** — the design record is the milestone
comments in studio's 4 source files plus `da-document-manager/PLANNING.md` (D1–D6).

---

## 2. Architecture (current scaffold)

**Stack:** React 19 + TypeScript ~6, Vite 8, Tailwind v4 via `@tailwindcss/vite` (`@import "tailwindcss"`
in `src/index.css`; no tailwind config). Runtime deps already declared **but not yet used** (staged for
M3): `@tanstack/react-virtual` (virtualized manager table), `papaparse` + `xlsx` (spreadsheet parsing).

**Entire `src/` today (4 files):**
- `main.tsx` — entry; runs the DA token handshake, then renders `<App/>` in `<StrictMode>`.
- `App.tsx` — the two-tab shell (`Generate` | `Document Manager`), `type Tab = 'generate' | 'manage'`.
  Both tabs are seeded into `mountedTabs` and kept mounted (inactive one hidden via a `hidden` class)
  so state survives tab switches. Includes the no-token banner. **Both tab bodies are `<Placeholder>`s**
  ("… — coming in the next milestone.").
- `api/daApi.ts` — **token store only** (`getToken`/`setToken`); a stub standing in for the full merged
  API that lands in M2.
- `index.css` — Tailwind import + a `.no-scrollbar` utility (kept for the manager table's per-cell
  horizontal scroll).

Plus `index.html`, `vite.config.ts`, `tsconfig*.json`, `public/favicon.svg`, and a committed `dist/`.

**State:** local React state only — no router, no context, no reducer, no TanStack Query.

---

## 3. The code you will port (lives in the siblings)

Studio implements none of this yet. When building M2/M3, port from these — generally taking the
**manager** copy for scan/status/bulk and the **generator** copy for write/template/build.

### Generator half — `da-document-generator/src/`
- `lib/parseData.ts` — `parseDataFile()` dispatches by extension: JSON (raw array or DA sheet
  `{ data: [...] }`), XLSX/XLS via SheetJS, else CSV via PapaParse; rows coerced to strings with a
  synthetic `_id`.
- `lib/generate.ts` — `applyTemplate(html, row)` does literal `{{key}}` → value replacement (no regex,
  no allow-list); plus post-publish page QA (title/description/OG/leftover tokens).
- `lib/buildDoc.ts` — output-path sanitizing, **Bake** mode (self-contained doc, `sheet-powered` off),
  hash-link resolution, and stamping the Metadata block with `generated-batch` (one ISO per run) +
  `last-updated`. Render modes: **Bake**, **Metadata** (leaves `{{tokens}}`, `sheet-powered=Y`, filled
  at runtime by the site's `content-replace.js`), **Both**.
- `lib/metadata.ts` — `upsertMetadataBlockOnDoc` / `readMetadataBlockFromDoc` / `serializeDoc` (the
  `div.metadata` key|value block; note block-manager and the generators each carry their own copy).
- UI: `components/GeneratePanel.tsx` (+ DataUpload, TemplatePanel, OutputPanel, StatusPills,
  ConfirmModal).

### Manager half — `da-document-manager/src/`
- `api/crawl.ts` — `crawlDirectory()` BFS with bounded concurrency.
- `lib/documentManager.ts` — `scanDocs()` two-phase progressive scan (discover → stream status in
  batches; no per-doc `/source` fetch); `recheckStatuses()`; opt-in `loadBatchMetadata()`.
- `api/daApi.ts` — `resolveStatuses()` (the **D6 strategy**: bulk status job first, authless CDN `HEAD`
  fallback), bulk mutate jobs (`bulkPreview/Publish/Unpublish`), per-path endpoints.
- `hooks/useDaDocumentActions.ts` — single-row + bulk lifecycle actions (one AEM job per ~500 paths,
  reconciled per-path, per-row fan-out fallback on whole-job failure).
- UI: `components/DocumentManagerView.tsx` (the main view), `DocumentManagerTable.tsx`, `StatusCells.tsx`.

### Shell reference (already two-tabbed)
`pdp-document-generator/src/App.tsx` + `components/{GeneratorTab,DocumentManagerTab}.tsx` — the exact
pattern studio's M3 tab bodies should follow.

### Duplicated-not-shared (drift risk — the reason M2 exists)
`daApi.ts`, `metadata.ts`, `concurrency.ts`, `http.ts`, `useDaDocumentActions.ts` are copy-pasted across
`pdp-document-generator`, `da-document-generator`, and `da-document-manager`, with differing line counts
(they've drifted). There is **no** shared TS lib for the Vite tools (`shared/da-api.js` at the repo root
is only for the static, no-build tools). M2 should merge these into studio's own `src/api`/`src/lib`.

---

## 4. DA / AEM integration & auth

- **Bases:** `admin.da.live` (DA content), `admin.hlx.page` (AEM admin), branch `main`. **org/repo are
  parsed from the DA path the user points at**, not hardcoded (`parseDAPath` → `[org, repo, ...rest]`).
- **DA Admin:** `GET /list`, `GET /source{path}.html`, `POST /source` (write), `POST /versionsource`
  (version before overwrite), `DELETE /source`.
- **AEM Admin:** `POST /preview/...`, `POST /live/...` (publish), `DELETE /live/...` (unpublish),
  `GET /status/...` (per-path) and `POST /status/.../*` (bulk status job), `POST /{preview|live}/.../*`
  (bulk mutate jobs, polled at `/job/...`). Authless CDN `HEAD` to `main--{repo}--{org}.aem.live` as the
  status fallback.
- **Token handshake** (`src/main.tsx`, identical to siblings): use `VITE_DA_TOKEN` if set; else
  dynamically import the da.live Nx Shell SDK (`https://da.live/nx/utils/sdk.js`) for `{ token }`, raced
  against timeouts; on failure the no-token banner shows. Token lives in a module-level var in
  `src/api/daApi.ts` (studio consolidated it here; it does **not** port the manager's separate
  `src/da.ts`).
- **Persistence:** none. DA is the store. No drafts folder, no localStorage, no scan cache (manager D5:
  reload = re-scan). Batch identity is stamped into each generated doc's Metadata block
  (`generated-batch`, `last-updated`).

---

## 5. Current status

**Works today:** the app builds and renders; the DA token handshake; the two-tab shell with
state-preserving tab switching and the no-token banner; the token-store stub.

**Not built (both tab bodies are placeholders):** no generator, no manager, no merged API, no table, no
actions.

**Registration debt:** studio is **absent** from the repo-root `index.html` (no landing-page card), the
root `README.md` tools table, and `SERVING.md`. Add it to all three when shipping a usable milestone.

**Sibling README caveat:** `da-document-manager/README.md` is **stale** (says "scaffold / hello world"),
but the manager is largely built. Trust `da-document-manager/PLANNING.md` + the code, not that README.

---

## 6. Milestones / roadmap

Documented only in studio's code comments:
- **M1 — scaffold (DONE):** two-tab shell + token handshake + token gate.
- **M2 — merged DA API:** replace the stub `src/api/daApi.ts` with the generator's write/template
  helpers + the manager's crawl/status/bulk-mutate layers + `daPathToProdUrl`, consolidating the
  duplicated copies. Keep token handling in this file.
- **M3 — the two tab bodies:** build `GeneratorTab` and `DocumentManagerView` (port from the siblings /
  `pdp-document-generator`'s tab components).
- **M4 — generate → manage handoff:** wire the tabs so freshly generated docs flow directly into the
  manager's set for preview/publish in the same session.

The **Manager tab's** design decisions live in `da-document-manager/PLANNING.md` (D1–D6). Still open
there: the exact initial column set (whether to include "Created" via a per-doc `/versions` call); folding
the confirmed bulk-status `/details` shape back into the D6 strategy; and the deferred **content-column**
strategy (D3: template-driven via `extractPlaceholders(html)` vs discovery vs explicit config) and its
value contract (D2). First manager iteration (D4) is universal "spine" columns only — Path, Status, Last
updated + the action columns — no content columns.

---

## 7. Build / run / ship

```bash
cd da-document-studio
npm install
echo "VITE_DA_TOKEN=your_token_here" > .env.local   # for local dev outside da.live
npm run dev      # http://localhost:3000
npm run build    # tsc -b && vite build → ./dist  (COMMIT the result)
```
- **Vite base:** `command === 'serve' ? '/' : '/da-document-studio/dist/'`. Rollup emits stable unhashed
  `assets/[name].js|css`.
- **No CI build.** AEM Code Sync serves repo files directly, so the built `dist/` is **committed**; after
  `npm run build`, commit `da-document-studio/` including `dist/` and push (~1–2 min to the code bus).
  Repo convention: **commit to `main` directly, no feature branches.**
- `.claude/launch.json` has a `da-document-studio` dev config. `.hlxignore` excludes `*.md`, so this
  handoff won't be served.

---

## 8. Known gotchas / constraints

- **It's a scaffold** — don't assume generator/manager behavior exists in studio; it must be ported.
- **Duplicated code has drifted** — three copies of `daApi.ts`/`metadata.ts`/`concurrency.ts`/`http.ts`/
  `useDaDocumentActions.ts` with differing line counts. When merging (M2), pick the most advanced copy
  per module and reconcile signatures.
- **Unused deps are staged for M3** (`@tanstack/react-virtual`, `papaparse`, `xlsx`) — not wiring that
  already exists.
- **Rate limits (why D6 exists):** admin API ~10 req/s per project; live CDN ~200 req/s. Never do
  per-doc `/status` calls at scan scale — use the bulk status job + CDN-HEAD fallback.
- **Bulk job reports are untrustworthy** — always reconcile per-path via `resolveStatuses` after a bulk
  mutate; the manager hook already fans out to per-row on whole-job failure.
- **No cache by design (D5):** reload = full re-scan; "recheck unknowns" retries only Unknown rows.
- **StrictMode double-invoke:** the token bootstrap runs once before render; effects that start a scan
  fire twice in dev — preserve the manager's `cancelled()` guard when porting.
- **Serving base must exactly equal `/da-document-studio/dist/`** or built assets 404. A transient
  `/dist/index.html` 404 right after a push is a Code Sync timing artifact — wait ~1–2 min.
- **Git:** studio is a single squashed commit (`7aba41c "committing da-document-studio"`); there's no
  incremental history to mine — the milestone comments + `da-document-manager/PLANNING.md` are the record.

---

## 9. Key files at a glance

| Concern | Path |
|---|---|
| Studio shell + token gate | `da-document-studio/src/App.tsx`, `src/main.tsx` |
| Studio token store stub (→ merged API in M2) | `da-document-studio/src/api/daApi.ts` |
| **Manager design spec (read this)** | `da-document-manager/PLANNING.md` |
| Port — generator logic | `da-document-generator/src/lib/{parseData,generate,buildDoc,metadata}.ts`, `src/components/GeneratePanel.tsx` |
| Port — manager logic | `da-document-manager/src/lib/documentManager.ts`, `src/api/{crawl,daApi}.ts`, `src/hooks/useDaDocumentActions.ts`, `src/components/DocumentManagerView.tsx` |
| Shell reference (two-tabbed) | `pdp-document-generator/src/App.tsx`, `src/components/{GeneratorTab,DocumentManagerTab}.tsx` |
| Serving / build reference | repo-root `README.md`, `SERVING.md` |
