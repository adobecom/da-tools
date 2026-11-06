# Serving these tools via AEM Edge Delivery + da.live

This repo is a container for standalone Vite/React **tools** (it does **not** use the EDS content pipeline). Each tool is served as static files from the Edge Delivery **code bus** and embedded in da.live as an app.

## URLs

The repo root serves a landing page; each tool is served at its own subfolder path. Built Vite tools live under `<tool>/dist/`; static (no-build) tools are served directly from `<tool>/`:

| Tool | In da.live (primary) | Direct (delivery) |
|---|---|---|
| DA Tools home | https://da.live/app/adobecom/da-tools/index | https://main--da-tools--adobecom.aem.live/index.html |
| `pdp-document-generator` | https://da.live/app/adobecom/da-tools/pdp-document-generator/dist/index | https://main--da-tools--adobecom.aem.live/pdp-document-generator/dist/index.html |
| `da-document-generator` | https://da.live/app/adobecom/da-tools/da-document-generator/dist/index | https://main--da-tools--adobecom.aem.live/da-document-generator/dist/index.html |
| `block-signature-migrator` | https://da.live/app/adobecom/da-tools/block-signature-migrator/dist/index | https://main--da-tools--adobecom.aem.live/block-signature-migrator/dist/index.html |
| `block-finder` (static) | https://da.live/app/adobecom/da-tools/block-finder/index | https://main--da-tools--adobecom.aem.live/block-finder/index.html |
| `document-counter` (static) | https://da.live/app/adobecom/da-tools/document-counter/index | https://main--da-tools--adobecom.aem.live/document-counter/index.html |
| `block-index` | https://da.live/app/adobecom/da-tools/block-index/dist/index | https://main--da-tools--adobecom.aem.live/block-index/dist/index.html |
| `github-package-comparator` (static) | https://da.live/app/adobecom/da-tools/github-package-comparator/index | https://main--da-tools--adobecom.aem.live/github-package-comparator/index.html |

Append `?ref=<branch>` to the da.live URL (or use `<branch>--da-tools--adobecom.aem.live` for the direct URL) to view a non-`main` branch.

## How it works (the parts that matter)

- **Two kinds of files:** *code* (this repo's built files, mirrored to the code bus by AEM Code Sync) vs *content* (authored docs — not used by these tools).
- **Two tiers:** a **preview** tier (`…aem.page` / `…preview.da.live`) and a **live** tier (`…aem.live`). Code is served on both automatically once Code Sync mirrors it — there is no separate "publish" step for code.
- **da.live embedding:** `da.live/app/{org}/{repo}/{path}` loads the "Nx Shell", which iframes `https://{ref}--{repo}--{org}.preview.da.live/{path}.html` and injects the DA auth token via `nx/utils/sdk.js`. So the app URL `…/da-document-generator/dist/index` loads `…preview.da.live/da-document-generator/dist/index.html`.

## Per-tool subfolder layout

Each tool is a self-contained Vite app that builds into its own `<tool>/dist/` folder:

- `<tool>/index.html` — the Vite source template (standard entry; used for `npm run dev` and the build).
- `<tool>/dist/index.html` — the **built** entry (committed). References `/<tool>/dist/assets/*`. Do not hand-edit — rebuild.
- `<tool>/dist/assets/*`, `<tool>/dist/favicon.svg` — built assets (committed).

The one rule: each tool's production **`base` must equal its served subfolder** (`/<tool>/dist/`), so the built HTML references its assets with correct absolute paths. In dev the base is `/`.

This mirrors the proven `adobecom/da-express-milo` pattern, which serves tools at `tools/<tool>/dist/index.html`.

## Static (no-build) tools

Some tools need no framework and are served **directly from their own folder** — no `dist/`, no Vite, no `base`:

- `<tool>/index.html` — hand-authored entry, served at `<tool>/index` (e.g. `block-finder/index.html` → `…/da-tools/block-finder/index`).
- `<tool>/index.js` — a plain browser ES module loaded via `<script type="module" src="./index.js">`; it pulls the DA SDK with `import DA_SDK from 'https://da.live/nx/utils/sdk.js'` (the same auth-token handshake the Vite tools use).
- All internal links are **relative** (`./…`, `../…`), so these tools need no `base` and can be relocated as a group. `block-finder/` and `document-counter/` also share `../shared/da-api.js` and link back to the home page via `../index.html`.

The repo-root `index.html` landing page is itself such a static file — served at `…/da-tools/index`.

> **Note (previously believed otherwise):** an earlier iteration of the doc generator placed its built entry at the repo **root** because a subfolder `/dist/index.html` appeared to 404 on the preview tier. That 404 was a **Code Sync sync-timing artifact** (the file wasn't on the code bus yet), *not* a platform rule. Subfolder `.html` files serve fine — confirmed on this repo (`/pdp-document-generator/dist/index.html`, `/da-document-generator/dist/index.html`) and on the reference repo. No root-entry workaround or postbuild step is needed.

## One-time setup (per repo — already done for this repo)

The site is registered once for the **whole repo**; individual tools need no extra registration.

1. Add `fstab.yaml` at the repo root, on the default branch (`main`).
2. Register the EDS site **once** via the Admin API:
   ```
   PUT https://admin.hlx.page/config/adobecom/sites/da-tools.json
   x-auth-token: <token from an admin.hlx.page/auth/adobe login>
   {"code":{"owner":"adobecom","repo":"da-tools"},
    "content":{"source":{"url":"https://content.da.live/adobecom/da-tools/","type":"markup"}}}
   ```
3. Install **AEM Code Sync** on the repo. If it isn't syncing (no commit activity; delivery returns `code-bus: 404`), **remove + re-add** the repo in the app's settings to force the initial sync.

## Troubleshooting (read the `x-error` response header)

```bash
curl -sS -D - -o /dev/null "https://main--da-tools--adobecom.aem.live/da-document-generator/dist/index.html" | grep -i "x-error\|HTTP/"
```

| `x-error` | Meaning | Fix |
|---|---|---|
| `Missing configuration` / `no such site` | Site not registered | Do setup step 2 |
| `failed to load /<tool>/dist/… from code-bus: 404` | The file isn't on the code bus — either not committed/pushed, or Code Sync hasn't synced yet | Confirm the file is committed under `<tool>/dist/`, push, wait ~1–2 min; if Code Sync shows no activity, re-add the repo (step 3) |
| `failed to load /index.md from content-bus: 404` (on bare `/`) | Harmless — these tools don't use the content pipeline. The landing page is a **code-bus** file at `/index.html`, reached as `…/da-tools/index` | Open `…/da-tools/index` (not bare `/`) |

## Admin API auth

Log in at `https://admin.hlx.page/auth/adobe`, copy the `auth_token` cookie, send it as the `x-auth-token` header. `GET /profile` is the hello-world (200 = token valid). The whole admin API is auth-gated.
