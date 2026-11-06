# Block Manager

Drill into any block used across a DA repo and see its **variant breakdown** — which variant tokens
exist, how many pages use each, and exactly which pages. Cloned from **Block Index**: it reuses the
same repo picker, crawl, per-directory caching, and token handshake, but scans one level deeper
(capturing each block's variants) and presents the results as a two-pane workspace.

Opens in DA at: **https://da.live/app/adobecom/da-tools/block-manager/dist/index**

## What it does

1. **Pick / add a repo** — choose from the shared list (all under the `adobecom` org), or **+ Add
   repo**: type a repo name, **Detect** finds its blocks path on GitHub, then **Save**. Same flow as
   Block Index.
2. **Scan** — crawl each content directory's HTML documents and extract, per block, the **variant
   tokens** each instance carries. A block is the first class of a `main > div > div[class]` (or the
   first cell of a `main > div > table`); its variants are the remaining classes / the parenthetical
   tokens, **split into individual tokens**. Instances with no variant are grouped under `(none)`.
   Per-directory results are cached, so rescans are incremental.
3. **Browse** — the left **sidebar** lists every block (usage count, filter, sort by usage / repo /
   alphabetical, own-vs-milo tint). Click a block and the **main area** shows each of its variant
   tokens with a page count and an expandable drill-down to the pages that use it (DA edit links, and
   published badges once you run Check Status).

Counts are **page-level**: a variant token's count is the number of pages containing at least one
instance of the block with that token (a page using two tokens appears under both). This is read-only
— the tool never writes page content; it only reads content and reads/writes its own scan cache.

## Data location

The scan cache (`audit-*.json`) and the repo registry (`repos.json`) live in a **separate** da.live
drafts folder from Block Index — `/adobecom/da-express-milo/drafts/maxn/block-manager-data`
(`AUDIT_ROOT` in `src/lib/config.ts`) — so the two tools never touch each other's data. The folder is
created automatically on first scan.

## Local dev

```bash
npm install
echo "VITE_DA_TOKEN=your_token_here" > .env.local   # needed for DA calls when run outside da.live
npm run dev      # port 3000
npm run build    # compiles to ./dist (commit the result)
```

Grab the token from an authenticated da.live session. GitHub auto-detection works without a token; DA
reads/writes (scanning, the repo registry) need one. Built output lives in `dist/` (committed) and is
served at `/block-manager/dist/`. See the repo-level [../SERVING.md](../SERVING.md) for how serving
works.

## Layout

- `src/api/` — `daApi.ts` (DA admin REST client + module-level token store) and `github.ts`
  (unauthenticated repo/blocks-path detection).
- `src/lib/` — `config.ts` (constants, `deriveConfig`, registry merge), `registry.ts`, `scan.ts`
  (`extractBlockVariants`, the variant-aware merge/sort, and the scan runner), `urls.ts`, `appLinks.ts`.
- `src/hooks/useBlockIndex.ts` — all per-repo state (a `dirParts` reducer) and the scan / status /
  registry actions.
- `src/components/` — `BlockWorkspace` (sidebar + main shell), `BlockDetail` (the selected block's
  variant breakdown + page drill-down), plus the shared `RepoBar`, `RepoForm`, `DirectoryScans`,
  `Legend`, `CopyButton`, and `icons`.

The token bootstrap in `src/main.tsx` and the `daApi.ts` token-store pattern mirror
`da-document-generator`.
