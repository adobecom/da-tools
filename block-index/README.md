# Block Index

Build a full index of every block in use across a DA repo. Pick a known repo, or add any `adobecom`
repo by name — the tool infers the da.live content, GitHub repo, and aem.live host from the name and
auto-detects the repo's blocks path. Results (per-directory block usage) are cached as `audit-*.json`
in a shared da.live drafts folder, and the list of repos lives in a shared `repos.json` there too.

Opens in DA at: **https://da.live/app/adobecom/da-tools/block-index/dist/index**

## What it does

1. **Pick / add a repo** — choose from the shared list (all under the `adobecom` org), or **+ Add
   repo**: type a repo name (e.g. `edu`), **Detect** finds its blocks path on GitHub, then **Save**
   adds it for everyone. The blocks path is the only per-repo setting; the branch (`stage`) is
   detected and stored silently, and milo blocks are always assumed.
2. **Scan** — crawl each content directory's HTML documents and extract the blocks each one uses
   (own-repo blocks vs. the milo foundation blocks it consumes vs. unrecognized). Per-directory
   results are cached, so rescans are incremental. Expanding **Directory Scans** counts the docs in
   each never-scanned dir up front (an ls-only crawl) so the button reads e.g. "Scan 145 docs".
3. **Check status** — HEAD-check each page against aem.live to mark which uses are published.
4. Browse blocks sorted by usage / repo / alphabetically, with kitchen-sink links, copy-all-paths,
   and per-page published badges.

**Editing / removing repos** is gated to whoever added a repo (by their da.live email, `addedBy` in
`repos.json`); the built-in seeds are locked. This is an **advisory UX affordance only** — it's
client-side and the shared `repos.json` is writable by anyone with folder access, so it is not a
security boundary.

## Local dev

```bash
npm install
echo "VITE_DA_TOKEN=your_token_here" > .env.local   # needed for DA calls when run outside da.live
npm run dev      # port 3000
npm run build    # compiles to ./dist (commit the result)
```

Grab the token from an authenticated da.live session. GitHub auto-detection works without a token;
DA reads/writes (scanning, the repo registry) need one. Built output lives in `dist/` (committed) and
is served at `/block-index/dist/`. See the repo-level [../SERVING.md](../SERVING.md) for how serving
works.

## Layout

- `src/api/` — `daApi.ts` (DA admin REST client + module-level token store) and `github.ts`
  (unauthenticated repo/blocks-path detection).
- `src/lib/` — `config.ts` (constants, `deriveConfig`, registry merge), `registry.ts`, `scan.ts`
  (block extraction, merge, sort, the scan runner), `urls.ts`, `appLinks.ts`.
- `src/hooks/useBlockIndex.ts` — all per-repo state (a `dirParts` reducer) and the scan / status /
  registry actions.
- `src/components/` — the UI (`RepoBar`, `RepoForm`, `DirectoryScans`, `ResultsList`/`BlockAccordion`,
  etc.). `ResultsList` hosts the FLIP sort animation.

The token bootstrap in `src/main.tsx` and the `daApi.ts` token-store pattern mirror
`da-document-generator`.
