# DA Document Manager

A DA (Document Authoring) tool for managing documents in a DA folder — point it at a folder, list the
documents it contains, and preview / publish / unpublish / delete them. Modeled on the **Document
Manager** tab of [pdp-document-generator](../pdp-document-generator/).

> **Status: scaffold.** This is currently a Vite + React "hello world" that renders and performs the DA
> auth-token handshake. The document-management features are not built yet.

Opens in DA at: **https://da.live/app/adobecom/da-tools/da-document-manager/dist/index**

## Stack

React 19 + TypeScript + Vite 8 + Tailwind CSS v4 — the same setup as the other Vite tools in this repo.
The DA auth token is obtained in `src/main.tsx` (from the da.live Nx Shell SDK when embedded, or
`VITE_DA_TOKEN` locally) and stored in `src/da.ts`.

## Local dev

```bash
npm install
echo "VITE_DA_TOKEN=your_token_here" > .env.local   # only needed for DA calls when run outside da.live
npm run dev      # port 3000
npm run build    # compiles to ./dist (commit the result)
```

Built output lives in `dist/` (committed) and is served at `/da-document-manager/dist/`. See the
repo-level [../SERVING.md](../SERVING.md) for how serving works, and [../README.md](../README.md) for the
"adding a new tool" recipe (set the Vite `base`, commit `dist/`, add a card to the root `index.html`).
