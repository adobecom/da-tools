# Block Manager — Project Handoff

A living handoff for anyone (human or agent) picking up work on the **block-manager** tool. Covers
the goals, the strategy and the decisions behind it, the architecture, the current status, how to run
and ship it, known constraints, and the roadmap. Read this first.

---

## 1. What this is

`block-manager/` is a standalone **DA (Document Authoring) tool** in the `da-tools` container repo. It
is a Vite + React + TypeScript SPA, built to `dist/` and served through AEM Edge Delivery, embedded in
da.live at:

> https://da.live/app/adobecom/da-tools/block-manager/dist/index

It was **cloned from the `block-index` tool** and extended. `block-index` remains a separate,
untouched tool; the two never share data.

### The immediate feature (Milestone 1, shipped)
Scan any DA repo and, for a selected block, show its **variant breakdown** — which variant tokens the
block is authored with, how many pages use each, and exactly which pages — in a two-pane
sidebar + detail workspace.

### The larger goal (the "why")
Milestone 1 is the first step toward an **on-demand tool for authors and developers to renegotiate
block "contracts" in bulk**. In EDS, a block is an implicit contract between authors (who fill a table)
and developers (whose `decorate()` reads it). Over years these contracts drift: the same concept is
authored as `inject-logo` on one block and `injectLogo` on another; values like `on` vs `true` diverge;
keys get renamed in code but not in the ~thousands of already-authored instances. The end goal is a
tool where someone can, at any time, say *"across every instance of `grid-marquee` on express, rename
the `background-color` key to `backgroundColor`"* (or remap a value, merge drifted keys, edit
positional cells) — and apply it in bulk after previewing a diff.

Variant scanning (M1) is deliberately the smallest useful slice of that: it reads deeper than
block-index (which throws variants away) and proves the crawl → parse → per-block-detail pipeline.

---

## 2. Strategy & key decisions

- **Clone, don't fork block-index in place.** block-index stays as-is; block-manager is a sibling that
  reuses its proven repo picker, crawl, caching, and token handshake.
- **No schema registry.** The heavier `block-signature-migrator` design (see that folder's
  `reference/design.md`) proposed per-block `*.schema.json` files + a conformance audit. We deliberately
  did **not** go that route. Block shape is meant to be **profiled from content on the fly**; drift is
  observed, not declared. This keeps the tool lightweight and author-friendly.
- **Read-only (so far).** The tool only reads page content; it reads/writes its **own** JSON caches in a
  DA drafts folder. No page content is ever mutated. Bulk write-back is a future milestone.
- **Isolated data location.** Scan cache + repo registry + directory counts live under
  `/adobecom/da-express-milo/drafts/maxn/block-manager-data` (`AUDIT_ROOT` in `src/lib/config.ts`),
  distinct from block-index's `block-index-data`. Created automatically on first write.
- **Variants split into individual tokens.** `marquee (large, light)` (or div classes
  `marquee large light`) contributes tokens `large` **and** `light`, each tallied separately.
  Variant-less instances group under the literal `(none)`.
- **No default repos.** The registry starts empty; every repo is added manually by a user and
  attributed to them (advisory gating). There are no "first-class" seed repos.

---

## 3. Architecture

### Stack
React 19 + TypeScript, Vite 8, Tailwind v4 via `@tailwindcss/vite` (but the UI is styled almost
entirely by hand-written classes in `src/index.css`; Tailwind mostly provides preflight). No router, no
state library, no TanStack. Deps are just `react`/`react-dom`.

### File map (`src/`)
- `main.tsx` — token bootstrap (see §6) then renders `App`.
- `App.tsx` — top-level composition and per-page UI state (`selectedBlock`, `selectedDirs`, add/edit
  form toggle). Gates the whole UI on a DA token and on a selected repo (`bi.cfg`).
- `hooks/useBlockIndex.ts` — **the brain.** All per-repo state and every async action (load registry,
  per-repo init, `scanDirs`, `countDirs`, `checkStatusDirs`, `selectRepo`, `saveRepo`, `removeRepo`). Uses a
  `dirParts` reducer so concurrent scan loops can't clobber each other via stale closures.
- `api/daApi.ts` — DA admin REST client (`ls`, `cat`, `collectDocs`, `readJson`, `writeJson`,
  `fetchPublishedPaths`) + the module-level token store (`getToken`/`setToken`).
- `api/github.ts` — unauthenticated repo/blocks-path detection for the Add-repo flow.
- `lib/config.ts` — constants (`AUDIT_ROOT`, `ORG`, `SKIP_DIRS`, `BLOCKS_EXCLUDE`, `MILO_TIER`),
  `SEED_REPOS` (now empty), `deriveConfig`, `mergeRegistry`.
- `lib/scan.ts` — **the parsing core.** `extractBlockVariants(html)` (the variant-aware extractor),
  `runScanForDir` (crawl a dir → `AuditRecord`), `mergeAllParts` (merge dir records → `MergedData`),
  `sortEntries`, plus GitHub/kitchen-sink block-list fetchers. Exports `NO_VARIANT = '(none)'`.
- `lib/registry.ts` — load/save the shared `repos.json`.
- `lib/urls.ts` / `lib/appLinks.ts` — DA edit / published / kitchen-sink URL helpers, and the "All
  Tools" back-link.
- `lib/session.ts` — the user-email singleton (for advisory gating).
- `components/`:
  - `RepoBar.tsx` — repo picker (+ empty state) and Add/Edit buttons.
  - `RepoForm.tsx` — add/edit a repo; GitHub auto-detect of the blocks path.
  - `DirectoryScans.tsx` — the directory panel: per-row **checkboxes**, a select-all header, and a
    selection-driven action bar (**Scan** / **Count** / **Check publish status** "N directories"). No
    per-row buttons.
  - `BlockWorkspace.tsx` — the two-pane shell: a resizable sidebar (block list with per-row kitchen-sink
    + copy icons, filter, sort, legend, and the "N blocks / across M documents" header) and the main
    pane. Owns sidebar width (drag-resize, persisted) and the filter.
  - `BlockDetail.tsx` — the selected block's "N Variants" pane (excludes `(none)` from the count) +
    per-variant page drill-down.
  - `Legend.tsx`, `CopyButton.tsx`, `KitchenSinkLink.tsx`, `icons.tsx` — leaf UI.

### Data model (`src/types.ts`)
- `AuditRecord` — one directory's cached scan (`audit-<dir>.json`): `scannedAt`, `docCount`,
  `scanErrors`, `repoBlocks`, `blocks: Record<blockName, docPath[]>`, and the M1 addition
  `variants?: Record<blockName, Record<variantToken, docPath[]>>` (token includes `(none)`).
  `blocks` is kept for the sidebar/counts/classification; `variants` powers the detail pane.
- `MergedData` — all dir records merged for the repo: `blocks`, `variants`, `docCount`, `scanErrors`,
  `publishedPaths`.
- `RepoEntry` / `RepoConfig` — a registry entry and its derived config (scan root, audit dir, GitHub &
  kitchen-sink tiers). `cfg` is **nullable** now (null = no repo selected).

### Storage layout (in DA, under `AUDIT_ROOT`)
```
drafts/maxn/block-manager-data/
├─ repos.json                     # the shared repo registry (user-added repos)
└─ <repoId>/
   ├─ audit-<dir>.json            # one cached scan per content directory
   └─ counts.json                 # persisted { counts: { <dir>: number } }
```

### Counting semantics
A variant token's count = **number of pages** containing at least one instance of the block with that
token (deduped per document). A page using two tokens of the same block appears under both; a page with
a variant-less instance appears under `(none)`. This mirrors block-index's "uses = pages" model. The
sum of a block's variant counts can therefore exceed its page total.

---

## 4. Scanning model & the tab-lifetime caveat

**Scans are client-side and tied to the browser tab.** `runScanForDir` fetches each document via the
DA admin API from the page's JS. If the tab is closed or navigated away, the JS stops, in-flight
fetches abort, and no further documents are scanned. There is **no** server-side/background job (unlike
the AEM publish jobs used elsewhere in this repo).

Persistence is **per directory, on completion**: each `audit-<dir>.json` is written only after that
directory finishes. So in a multi-directory scan, already-completed directories survive a tab close; the
directory that was mid-scan is lost (not partially saved) and nothing after it runs. Practical
implication: for a huge directory, select and scan it on its own so a later interruption doesn't cost
the smaller ones (the checkbox selection in the Directory Scans panel exists partly for this).

---

## 5. Current status (what works today)

Milestone 1 is complete and committed to `main`, plus several rounds of refinements:

- **Repo management:** no default repos; add any `adobecom` repo by name with GitHub auto-detect of the
  blocks path (the detect button sits by the Blocks-path input); advisory edit/remove gating by the
  adder's da.live email; empty-state prompts.
- **Directory panel (selection-driven):** per-directory checkboxes + a select-all header; **Scan N
  directories**, **Count N directories**, and **Check publish status N directories** all act on the
  selected directories (disabled when nothing is selected). There are no per-row action buttons and no
  separate top toolbar.
- **Persisted counts:** directory doc-counts are stored in `counts.json` and loaded on repo open; they
  are no longer recomputed automatically on every load.
- **Variant scan + detail:** the sidebar lists every block with a "N blocks / across M documents"
  header, filter, sort (usage/repo/alphabetical), and full-row repo tints (own=amber, milo=pink,
  unrecognized=gray). Each row shows a kitchen-sink link + copy-all-URLs icon and, after a status check,
  a green `published / total` fraction. Selecting a block shows a "N Variants" pane (excluding the
  `(none)` bucket from the count) with each variant's page count and an expandable page drill-down
  (DA edit links + published badges).
- **Publish status:** the selection-based check HEAD-probes aem.live to mark published pages, stored per
  directory in the audit records.
- **Sidebar UX:** drag-resizable (260–520px, persisted); "Sort by:" label above an enlarged legend;
  block rows are bordered list rows (no pills) with a darker repo-tint on hover/selection.

---

## 6. Running, building, shipping

### Auth / token
`src/main.tsx` `initToken()`: in local dev it reads `import.meta.env.VITE_DA_TOKEN`; when embedded in
da.live it dynamically imports the DA "Nx Shell" SDK (`https://da.live/nx/utils/sdk.js`) for
`{ token, email }`, raced against timeouts so standalone use never hangs. The token lives in a
module-level singleton in `api/daApi.ts`.

### Local dev
```bash
cd block-manager
npm install
echo "VITE_DA_TOKEN=your_token_here" > .env.local   # a da.live session token; needed for DA calls
npm run dev      # http://localhost:3000
npm run build    # tsc -b && vite build → ./dist  (COMMIT the result)
```
GitHub auto-detection works without a token; DA reads/writes (scanning, registry, counts) need one.

### Shipping
There is **no CI build**. AEM Code Sync serves the repo's files directly, so the built `dist/` is
**committed**. After `npm run build`, commit `block-manager/` including `dist/` and push; Code Sync
mirrors it in ~1–2 min. Repo convention (see the repo's memory / git history): **commit to `main`
directly, no feature branches.** Also add/keep the landing-page card in the repo-root `index.html`.

---

## 7. Known constraints & gotchas

- **Advisory gating is not security.** Edit/remove-repo gating is client-side by email; `repos.json` is
  writable by anyone with folder access.
- **No virtualization.** The block list and page drill-downs are plain DOM. Fine at current scale
  (dozens–hundreds of blocks; page lists live inside collapsed `<details>`), but a single block with
  tens of thousands of pages would render a long list.
- **Table-form block names.** DA source is usually the div-grid form (`<div class="name variant">`);
  `extractBlockVariants` also handles the `<table>` form but keeps block-index's first-token name
  behavior, so a space-containing table label could truncate. Rare in DA-authored content.
- **StrictMode double-fire.** Per-repo init runs read-only and is guarded by a `cancelled` flag; the dev
  double-invoke is merely wasteful.
- **Counts vs scans.** A scanned directory's authoritative count comes from its `AuditRecord.docCount`;
  `counts.json` is the pre-scan estimate for unscanned directories. Both are shown in the row meta.
- **`dist/` must be rebuilt before committing** — never hand-edit `dist/index.html`.

---

## 8. Roadmap (deferred milestones)

Roughly in the intended order, toward the bulk-contract-editing goal:

1. **Key/value inventory** — for a selected block, surface each authored key with its value
   distribution and instance counts (the drift view).
2. **Suggested merges** — detect near-duplicate keys (e.g. `background-color` vs `backgroundColor`) and
   value-vs-flag mismatches, and propose merges/renames.
3. **Key matrix** — a pages × keys grid for cross-cutting inspection.
4. **Bulk write-back with preview** — typed transforms (rename key, remap value, merge keys, add/remove
   key, edit positional cells) applied across all matching instances, with a per-instance before/after
   diff, staleness re-read at write time, and preview → publish. This is the payoff and the first
   **mutating** capability; design it with the same care as the block-signature-migrator's governance
   notes (changeset, veto, rollback via DA version history).

The heavier, schema-first alternative is documented in `../block-signature-migrator/reference/`
(`design.md` + `CLAUDE.md`); we chose the lighter, profile-from-content path, but that doc is a useful
reference for the transform vocabulary and governance model.

---

## 9. Key files at a glance

| Concern | File |
|---|---|
| State + all actions | `src/hooks/useBlockIndex.ts` |
| Variant parsing / merge / sort | `src/lib/scan.ts` |
| DA/AEM REST client + token store | `src/api/daApi.ts` |
| Config, `AUDIT_ROOT`, `deriveConfig` | `src/lib/config.ts` |
| Data model | `src/types.ts` |
| Two-pane workspace (resize, filter, sort) | `src/components/BlockWorkspace.tsx` |
| Variant detail + page drill-down | `src/components/BlockDetail.tsx` |
| Directory panel (checkboxes, actions) | `src/components/DirectoryScans.tsx` |
| Add/edit repo (auto-detect) | `src/components/RepoForm.tsx` |
| Styles | `src/index.css` |
| Token bootstrap | `src/main.tsx` |
