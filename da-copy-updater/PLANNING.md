# DA Copy Updater — Planning & Decisions

Browser tool (da.live app) that makes a surgical copy change across a DA folder tree, then previews and
publishes only the pages it changed. First job: **MWPW-214582** — replace the Print PDP highlight-block
row "Free shipping and returns" with "Easy 30-day returns" (workaround for DOTCOM-202216).
Not served (`*.md` is in `.hlxignore`).

Opens in DA at: **https://da.live/app/adobecom/da-tools/da-copy-updater/dist/index**

## Decisions

| # | Decision |
|---|---|
| D1 | Lives in **da-tools** as a Vite + React + TS + Tailwind tool (same stack as `da-document-manager`). Runs in the browser; the DA token comes from the da.live Nx Shell SDK. |
| D2 | **UI:** a folder-path input plus a phased flow, **Scan (dry run) → Apply & Preview → Publish**, not a single button. Progress bar, bucket counters, log console, results table, downloadable report. |
| D3 | **Find/replace is hardcoded for v1** (block `highlight`, element `h2`, exact text), but defined as a `ReplaceRule` object so a later "Find & Replace" feature (document-manager fast-follow) can expose it as inputs. |
| D4 | **Skip docs with unpublished changes** (source edited after last publish) and list them in the report. |
| D5 | **Never publish a doc that wasn't live before the run.** Not-live docs (including drafts and default documents) get a source edit only. |
| D6 | **Default documents are in scope.** The 9 templates in `/express/print/document-generator/` have the identical highlight row; the same engine updates them (source only, per D5). |
| D7 | Wording variants, a missing block, or duplicate matches are **skipped and reported, never edited**. |
| D8 | A **DA version is created before every write** (label `Before MWPW-214582 copy update`). This is the rollback path; the browser doesn't hold backups. |
| D9 | Edits are attributed to the token owner (whoever runs the tool). |
| D10 | Final copy "Easy 30-day returns" is **confirmed** with Zazzle. |
| D11 | The DA/AEM admin helpers are **copied** from `pdp-document-generator` (with a header comment naming the source) rather than extracted to a shared package, so this ticket doesn't touch a production tool. Extract to a shared module later with the document-manager feature. |
| D12 | The engine runs on the main thread (needs `DOMParser`). Mitigate background-tab throttling with the Screen Wake Lock API, a "keep this tab visible" banner, and a `beforeunload` warning while running. Sleeps and job polling use a Web Worker timer, which Chrome doesn't throttle in background tabs. |

## The rule (v1)

```ts
const RULE: ReplaceRule = {
  id: 'MWPW-214582',
  blockClass: 'highlight',
  element: 'h2',
  find: 'Free shipping and returns',
  replace: 'Easy 30-day returns',
  versionLabel: 'Before MWPW-214582 copy update',
};
```

Confirmed source shape, identical in live PDPs, the drafts test folder, and the default documents:
`<div class="highlight">…<div><h2>Free shipping and returns</h2></div>…</div>`. The icon and the other
three rows are untouched.

## Classification (pure function, unit-tested)

`classify(html, rule)` uses `DOMParser` to *locate*, then applies the edit as an **exact string splice**
on the original HTML (no DOM re-serialization, so no attribute or entity churn). Outcomes:

| Outcome | Condition | Action |
|---|---|---|
| `match` | Exactly one `.highlight h2` with exact text `find`, and exactly one `<h2>find</h2>` substring in the raw HTML | Will update |
| `already-updated` | `.highlight h2` == `replace`, and no `find` present | Skip (idempotent) |
| `variant` | A `.highlight h2` matches `/free\s+shipping/i` after normalization (case, whitespace, `&amp;`) but not exactly | Skip + report the found text |
| `no-block` | No `.highlight` block | Skip + report |
| `no-match` | Highlight block exists but has no shipping row | Skip + report |
| `ambiguous` | More than one match, or the DOM and string counts disagree | Skip + report |

Post-condition check on every edit: `newHtml === oldHtml.replace(exactSubstring, replacedSubstring)` and
the length delta equals `replace.length - find.length`. If it fails → `error`, no write.

## Phases

### 1. Scan (dry run, read-only)
1. Normalize the input (accepts `/org/repo/path` or a `da.live/#/…` / `da.live/edit#/…` URL).
2. Crawl with `crawlDirectory` (DA `/list`, BFS) → paths plus DA `lastModified`.
3. Bulk status (`bulkResolveStatus`, jobs of 1000, `select: edit/preview/live`) →
   `publishLastModified` and `previewLastModified` per path.
4. Fetch each source (`cat`, concurrency 12) → `classify`; keep only the summary (no HTML in memory).
5. Derive per doc:
   - `wasLive` = `publishLastModified` present.
   - `unpublishedChanges` = `wasLive && (sourceLastModified > publishLastModified || previewLastModified > publishLastModified)`,
     The bulk status job omits `sourceLastModified` for DA-backed sites (confirmed on the first test
     scan), so the source time is DA's `/list` `lastModified`. Docs the job doesn't return are probed
     on aem.live (404 = not live).
6. Final bucket for each doc:
   - `will-update-and-publish`: `match` + live + no unpublished changes.
   - `will-update-source-only`: `match` + not live.
   - `skip-unpublished-changes`: `match` + live + unpublished changes.
   - `already-updated`, `variant`, `no-block`, `no-match`, `ambiguous`, `error`.
7. Show counts per bucket and per product type (first folder under the root). Persist the scan to the
   journal.

### 2. Apply & Preview (writes)
For each `will-update-*` doc (concurrency 12, `fetchWithRetry`):
1. Re-read the source. If its hash changed since the scan, skip a live doc ("Edited after the scan");
   a not-live doc is re-classified and still updated if it matches.
2. `createDocVersion(path, RULE.versionLabel)`.
3. `postDoc(path, newHtml)`.
4. Re-`cat` and verify `replace` is present and `find` is absent → `updated`, else `error`.
5. Journal the result.

Before preview, each doc must still read back exactly as we wrote it (`writtenHash`) and still be live;
otherwise it's skipped. Then run a bulk preview job (chunks of 500, 3 concurrent jobs) for the updated docs that were live before
the run, and reconcile with bulk status. Preview failures are listed with a **Retry** button.

**QA gate:** export the updated docs as `www.stage.adobe.com/...` URLs (pdp-render-checker accepts these
over VPN; `.aem.page` is auth-gated) and run pdp-render-checker before publishing.

### 3. Publish (requires typed confirmation when the root is outside `/drafts/`)
Pre-checks per doc: still live, preview time unchanged since our preview, no source edit after it, and
source still exactly what we wrote. Then bulk publish → reconcile with bulk status → `published` or `publish-failed`.
Retry until no doc is left in an unknown state (ticket requirement).

## Resumability and safety

- **Journal in IndexedDB**, keyed by run ID and root path. It holds the scan summary plus per-doc state
  (`updated`, `previewed`, `published`). After a reload, a token expiry, or a closed tab, the tool offers
  **Resume**. Docs written by this run are publishable even though their DA `lastModified` is now newer
  than their publish time, so the journal keeps them out of the `unpublished-changes` bucket.
- A re-scan is idempotent: updated docs classify as `already-updated`.
- **Token expiry (401)** → pause the run with "Reload da.live and Resume". A 401 never counts as a doc
  failure.
- **Pause/Abort** button (an `AbortSignal` threaded through the workers).
- **Single-runner lock:** a `BroadcastChannel` / `localStorage` lock prevents two tabs running the same
  root.
- Typed confirmation for non-`/drafts/` roots. Publish is never offered for not-live docs.
- The rollback path is DA version history; the report lists every updated path for targeted restore.

## Report

- Live in the UI: a results table filterable by bucket, with an edit link, a live link, the reason, and
  any found variant text.
- **Download** as CSV and JSON. Columns: `path, productType, outcome, reason, foundText,
  daLastModified, publishLastModified, editUrl, liveUrl, prodUrl`.
- Summary counts by outcome and product type: scanned / changed / skipped (by reason) / failed, per the
  ticket's acceptance criteria.
- Later: **Save report to DA** (JSON) so the run is shareable after the tab closes (not built in v1).

## Module layout

```
da-copy-updater/
  index.html, vite.config.ts (base '/da-copy-updater/dist/'), vitest.config.ts, package.json, tsconfig*.json
  src/
    main.tsx              # DA SDK token handshake (copied from da-document-manager)
    App.tsx               # path input, steps, confirmations, saved runs, Web Locks + Wake Lock
    api/daApi.ts          # adapted from pdp-document-generator: source read/write/version, paged
                          #   /list crawl, bulk status (timestamps), bulk preview/publish, live fetch
    lib/http.ts           # fetchWithRetry (429/5xx/Retry-After, network retry, 401 → AuthError)
    lib/concurrency.ts    # runPool (abortable) + sleep on a Web Worker timer (no background throttling)
    engine/rule.ts        # ReplaceRule type + the MWPW-214582 rule
    engine/classify.ts    # pure: html → outcome (+ newHtml)
    engine/model.ts       # DocRecord, buckets, unpublished-changes rule, result labels, hash
    engine/paths.ts       # input normalization, drafts detection
    engine/run.ts         # scan / apply / preview / publish / verifyLive phases
    engine/journal.ts     # IndexedDB persistence + resume
    engine/report.ts      # CSV / JSON / QA URL list
    components/           # ConfirmModal, Progress (bar + log console), Results (summary + virtualized table)
  test/logic.test.ts      # classify, buckets, helpers (fixture = real DA source)
  test/engine.test.ts     # full flow against an in-memory DA/AEM fake
  dist/                   # committed build
```

Repo touch points: a "Copy Updater" card in the root `index.html`, rows in `README.md` and `SERVING.md`.

## Estimated throughput (~44k docs)

These are estimates; measure them on the test folder.
- Scan ≈ 15–25 min.
- Apply ≈ 25–40 min (3 DA calls + 1 verify read per doc at concurrency 12).
- Preview and publish ≈ 1–2 h each (88 jobs of 500 at 3 concurrent).
- Run it per product type to keep each session short.

## Status

Built: all phases, journal/resume, report, UI; 38 unit/flow tests pass. Next: the test run below.

## Test plan

1. **Unit + flow tests:** `npm test`.
2. **Test run on `/drafts/maxn/document-generator`** (6 product folders, none live today):
   1. Scan → expect every doc in *Will update (source only)*. Check the timestamps in the CSV.
   2. To exercise publish and skip logic first, publish a few docs in DA (any doc under `/drafts` may be
      published), then edit 1–2 of them after publishing, change the wording on 1, and re-scan. Expect
      *Will update + publish*, *Skip: unpublished changes*, and *Skip: different wording* respectively.
      This also validates the unpublished-changes timestamp comparison (D4) against real data.
   3. Update → check a doc's diff and its "Before MWPW-214582 copy update" version in DA history.
   4. Preview → QA URLs → Publish → Verify live.
   5. Re-scan → expect *Already updated*, no matches.
   6. Pause or close the tab mid-update → reopen from Saved runs → continue.
3. **Production pilot:** the smallest product-type folder → QA sample → the remaining types one folder at
   a time → `/express/print/document-generator/` (default documents, source only).

## Resolved questions

- Name: `da-copy-updater` ("Copy Updater").
- Publishing test documents under `/drafts` is fine.
- Production runs go one product-type folder at a time.
- Ask authors to pause edits on `/express/print/` while each folder runs (pages edited mid-run are
  skipped and reported, not overwritten).
