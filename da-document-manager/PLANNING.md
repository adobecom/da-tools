# DA Document Manager — Planning & Decisions

A living design/decisions doc for the `da-document-manager` tool. Records the decisions and
reference notes made while planning, so implementation can proceed from a clear spec. Not served
(`*.md` is in `.hlxignore`). Update this as we settle each question.

## Vision

A **general-purpose** DA (Document Authoring) document manager, usable by many teams — deliberately
abstract, *not* product-specific like `pdp-document-generator`. UI modeled on the Document Manager tab
of `pdp-document-generator`: an input for a DA folder path → a table listing every document under it,
with metadata columns + per-row lifecycle action buttons.

Working style: slow, iterative, decision-first — settle architecture/strategy before building.

## Decisions

### D1 — Columns must not be hardcoded (the pdp anti-pattern)
`pdp-document-generator`'s Document Manager columns are a fixed 16-column set hardcoded in
`pdp-document-generator/src/components/DocumentManagerTable.tsx` (a `SORT_COLUMNS` array + literal
header `<div>`s + a `COLUMN_WIDTHS` array), populated from a fixed metadata contract (`product-id`,
`product-type`, `generated-batch`, `last-updated` + tagged `title`/`short_title`/`description`). That
product-specificity is exactly what this tool must avoid.

### D2 — "Headers" vs "values" are separate concerns
Deciding columns is really two questions: (a) *which* columns (the header set), and (b) *where each
document's value for a column comes from* during the scan (the value contract). A template's
`{{placeholders}}` can answer (a) — but (a) is only useful if (b) has a generic answer. The clean
pairing: values stored in an EDS **Metadata block keyed by the placeholder names** (= da-document-
generator "metadata mode"). Fully-baked docs inline values into the body unmarked → not readable
per-column. So content columns only work for metadata-bearing docs.

### D3 — Content-column strategy: TABLED for now
Defer choosing template-driven vs discovery vs explicit-config for content columns. Prior art for the
template route when we return to it: `extractPlaceholders(html)` (regex `/\{\{([^}]+)\}\}/g`, deduped)
in both tools' `src/api/daApi.ts`.

### D4 — First iteration = universal "spine" columns only
Display only:
- **Action columns:** Preview, Publish, Unpublish, Delete (per-row operation buttons).
- **A few metadata columns** (structural/lifecycle, from the path + admin APIs): Path, Status
  (draft/previewed/published), Last updated. (Created date only if we accept a per-doc `/versions`
  call — see reference below. Exact set is an open question.)
No content columns yet.

Reusable prior art for the actions: pdp's `useDaDocumentActions` (`src/hooks/useDaDocumentActions.ts`)
+ `src/api/daApi.ts` already implement preview/publish/unpublish/delete against the admin APIs.

### D5 — Scan: fast always-live, no persisted cache
Make the scan fast + reliable enough that no DA-side cache is needed. (A JSON-doc cache — the Block
Index pattern — was largely a workaround for a slow scan; it adds staleness + multi-user ownership
complexity.) Reload = re-scan.

### D6 — Status via bulk job (primary) + authless CDN HEAD (fallback); never per-doc admin status calls
Root cause of pdp's "N docs Unknown" storm: one `admin.hlx.page/status` GET per doc against an API
rate-limited to ~10 req/s per project (aem.live/docs/limits) → throttles + circuit breaker can't fire
mid-scan. Replacement (implemented first in the pdp scan fix — see the approved plan file):
- **Discovery:** `/list` BFS (`collectDocs`) for all paths (+ last-modified). Skip per-doc `/source`
  unless content columns need it (they don't in D4).
- **Status — primary:** one bulk status job `POST admin.hlx.page/status/{org}/{repo}/main/*` with
  `{ paths, select: ['preview','live'] }` → poll `GET /job/{org}/{repo}/main/status/{jobName}` → `GET
  .../details` → per-path preview+live in one job (draft/previewed/published). *The `/details` shape is
  documented but pending one live confirmation; the pdp fix falls back safely if it doesn't parse.*
- **Status — fallback + targeted recheck:** authless bodyless `HEAD` to the live CDN
  (`main--{repo}--{org}.aem.live/...`, ~200 req/s host limit) = published (previewed best-effort — the
  preview tier is often auth-gated). Basis: `shared/da-api.js` `fetchPublishedPaths`.
- **Robustness:** honor `Retry-After` in job polling; "recheck unknowns only" instead of full rescan.

## Reference — DA / AEM Admin APIs (established during planning)

### Document list & content — DA Admin API, base `https://admin.da.live`
- `GET /list/{org}/{repo}/{path}` → directory listing. Per entry: `path`, `name`, file-vs-folder
  (`ext` present for files e.g. `html`, absent for folders — confirmed by `pdp-document-generator/src/api/crawl.ts`),
  `size`, and a **last-modified** timestamp. Recurse into folders for the full tree (BFS, as pdp's
  `crawlDirectory` does).
- `GET /source/{org}/{repo}/{path}.html` → the document's **content** (raw HTML) + content metadata
  (content-type, last-modified/etag). **No lifecycle status.**
- Version history endpoint (path to confirm — `/versions` vs `/versionlist`/`/versionsource`) → list of
  versions, each with a `timestamp` (+ author/label). Earliest version ≈ a "created" proxy.

### Lifecycle status — AEM Admin API, base `https://admin.hlx.page` — a SEPARATE call
Status is NOT in the DA source fetch; it needs a second call (as pdp's `checkPageStatus` does).
- `GET /status/{org}/{repo}/{ref}/{path}` (ref = `main`) → `{ preview, live, edit, code, links }`.
  Each of `preview`/`live`/`edit` has `status` (HTTP code) + `lastModified` (+ `lastModifiedBy`).
- Lifecycle inference: `edit` 200 but preview/live 404 → **draft**; `preview` 200, `live` 404 →
  **previewed**; `live` 200 → **published**.

### Timestamps — created vs last-updated
- **Last-updated: available.** From `/list` `lastModified`, or `/status` `edit.lastModified` /
  `preview.lastModified`.
- **Created: NOT a direct field** on list/source/status. Only proxy = earliest `/versions` timestamp
  (extra per-doc call; assumes history reaches creation).

Confidence: the AEM `/status` shape and the endpoint set are confirmed (AEM admin docs + this repo's
code); exact DA `/list` field names should be re-confirmed against a live authenticated response at
implementation time.

## Open questions / next

- Exact initial metadata column set (Path, Status, Last updated — include Created via `/versions`?).
- **Scan strategy** — DECIDED (D5/D6): fast always-live scan, no cache; status via bulk job + CDN HEAD.
  First implemented in the pdp-document-generator scan fix (see the approved plan file). Once verified
  live there, fold the confirmed bulk-status `/details` shape back into D6.
- (Deferred) content-column strategy (D3) + value contract (D2).
