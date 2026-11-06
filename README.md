# da-tools — DA tools container

A container repository that hosts **multiple standalone DA (Document Authoring) tools** side-by-side, with a landing page at the repo root ([`index.html`](./index.html)) that links to all of them. Most tools are self-contained Vite + React apps in their own top-level folder, built to `<tool>/dist/` and served as static files from AEM Edge Delivery Services (the "code bus"); a few are lighter-weight no-build tools served directly from their own folder. Each tool is embedded in DA at its own URL.

## Tools

Open the **[DA Tools home](https://da.live/app/adobecom/da-tools/index)** page for cards linking to every tool, or go straight to one:

| Tool | Folder | Opens in DA at |
|---|---|---|
| **PDP Document Generator** — bulk-generate DA pages from product data + templates | [`pdp-document-generator/`](./pdp-document-generator/) | https://da.live/app/adobecom/da-tools/pdp-document-generator/dist/index |
| **DA Document Generator** — fill a template's `{{tokens}}` from any spreadsheet/JSON | [`da-document-generator/`](./da-document-generator/) | https://da.live/app/adobecom/da-tools/da-document-generator/dist/index |
| **Block Finder** — find every `/express` page that uses a given block | [`block-finder/`](./block-finder/) | https://da.live/app/adobecom/da-tools/block-finder/index |
| **Document Counter** — count HTML documents under any directory path | [`document-counter/`](./document-counter/) | https://da.live/app/adobecom/da-tools/document-counter/index |
| **Block Index** — pick a known repo, or add any `adobecom` DA repo by name, and build a full index of every block in use | [`block-index/`](./block-index/) | https://da.live/app/adobecom/da-tools/block-index/dist/index |
| **Block Manager** — drill into any block and see its variant breakdown: which variants exist, how many pages use each, and where | [`block-manager/`](./block-manager/) | https://da.live/app/adobecom/da-tools/block-manager/dist/index |
| **Block Signature Migrator** — inspect block structure, infer block schemas, audit signature drift | [`block-signature-migrator/`](./block-signature-migrator/) | https://da.live/app/adobecom/da-tools/block-signature-migrator/dist/index |
| **GitHub Package Comparator** — compare a JSON file (e.g. `package.json`) across GitHub repos | [`github-package-comparator/`](./github-package-comparator/) | https://da.live/app/adobecom/da-tools/github-package-comparator/index |

Block Finder, Document Counter, and GitHub Package Comparator are static (no-build) tools served at `<tool>/index`; the others are built Vite apps served at `<tool>/dist/index`. Append `?ref=<branch>` to preview a non-`main` branch, e.g. `…/da-document-generator/dist/index?ref=my-branch`.

## Repository layout

```
da-tools/                   (repo)
├─ index.html               # landing page — cards linking to every tool
├─ pdp-document-generator/  # PDP tool — bulk-generate product pages (Zazzle)   [Vite/React, built]
│  ├─ src/  index.html  vite.config.ts  package.json
│  └─ dist/{ index.html, assets/ }   # built output (committed)
├─ da-document-generator/   # generic {{token}} → DA document generator         [Vite/React, built]
│  ├─ src/  index.html  vite.config.ts  package.json
│  └─ dist/{ index.html, assets/ }   # built output (committed)
├─ block-signature-migrator/ # inspect block structure + schemas, audit drift   [Vite/React, built]
│  ├─ src/  index.html  vite.config.js  package.json
│  └─ dist/{ index.html, assets/ }   # built output (committed)
├─ block-index/             # index every block in use across any adobecom repo  [Vite/React, built]
│  ├─ src/  index.html  vite.config.ts  package.json
│  └─ dist/{ index.html, assets/ }   # built output (committed)
├─ block-manager/           # drill into a block; per-variant usage + page drill-down  [Vite/React, built]
│  ├─ src/  index.html  vite.config.ts  package.json
│  └─ dist/{ index.html, assets/ }   # built output (committed)
├─ block-finder/            # find every /express page using a block            [static, no build]
│  └─ index.html  index.js
├─ document-counter/        # count HTML docs under a directory path            [static, no build]
│  └─ index.html  index.js
├─ github-package-comparator/ # compare package.json across GitHub repos        [static, no build]
│  └─ index.html  index.js  github-package-comparator.js  *.css
├─ shared/da-api.js         # DA fetch helpers shared by the static tools
├─ fstab.yaml               # repo-level: registers the EDS site
├─ SERVING.md               # repo-level: how serving works + troubleshooting
└─ README.md
```

Each Vite tool is independent: its own `package.json`, `node_modules`, Vite config, and build. There is intentionally **no** root `package.json` — you work inside a tool's folder. The static tools (`block-finder/`, `document-counter/`, `github-package-comparator/`) have no build at all — they're hand-authored ES modules that share `shared/da-api.js` and load the DA SDK from `https://da.live/nx/utils/sdk.js` at runtime.

## Working on a tool

```bash
cd pdp-document-generator      # or: cd da-document-generator
npm install
npm run dev                    # local dev server
npm run build                  # compiles to ./dist (commit the result)
```

The built `dist/` is committed because AEM Code Sync serves the repo's files directly (there is no CI build step). After `npm run build`, commit the updated `<tool>/dist/` and push — Code Sync mirrors it to the code bus in ~1–2 min.

### Static tools — local dev

The static tools (`block-finder/`, `document-counter/`, `github-package-comparator/`) have no dev server. Serve the **repo root** with any static server (so each tool's `../shared/*.js` imports resolve) and open the tool's path:

```bash
npx serve -l 8777 .    # or: python3 -m http.server 8777   — run from the repo root
```

Then open e.g. `http://localhost:8777/block-finder/index.html`. This is fine for UI work, but the DA auth token is only injected when a tool runs embedded in da.live, so token-gated behavior reaches DA only from the da.live app URL — not from a plain local tab. (The Vite tools, including `block-index`, instead take a local token via `VITE_DA_TOKEN`; see each tool's README.)

## Adding a new tool

1. Create a new top-level folder `my-tool/` as a standard Vite + React app (copy an existing tool as a starting point).
2. In its `vite.config.ts`, set the production `base` to the served subfolder:
   ```ts
   const base = command === 'serve' ? '/' : '/my-tool/dist/'
   ```
3. `npm install && npm run build` inside the folder, commit `my-tool/` (including `dist/`), and push.
4. It's live at `https://da.live/app/adobecom/da-tools/my-tool/dist/index`.

Then add a card for it to the root [`index.html`](./index.html) so it appears on the DA Tools home page. A tool that needs no framework can instead be a **static, no-build** folder (like `block-finder/`) — a plain `index.html` + ES modules served directly at `<tool>/index`, with no `dist/` and no `base` to set; see [SERVING.md](./SERVING.md).

No per-tool site registration is needed — the whole repo is one EDS site (see [SERVING.md](./SERVING.md)).

## Serving

All tools are served through AEM Edge Delivery Services and embedded in da.live. See **[SERVING.md](./SERVING.md)** for how it works (site registration, Code Sync, the per-tool subfolder pattern) and an `x-error` troubleshooting table.
