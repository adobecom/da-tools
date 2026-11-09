// Adapted from pdp-document-generator/src/api/daApi.ts and src/api/crawl.ts. Differences: every
// call takes an AbortSignal, a 401 raises AuthError (see lib/http.ts), and the bulk status job
// returns the raw source/preview/publish timestamps. Those timestamps are needed to detect
// unpublished changes and to confirm a preview or publish actually happened: "is live" alone says
// nothing for a page that was already live before the run.
import { fetchWithRetry } from '../lib/http';
import { runPool, sleep } from '../lib/concurrency';

const DA_API = 'https://admin.da.live';
const HLX_ADMIN = 'https://admin.hlx.page';
const BRANCH = 'main';

let token: string | null = null;

export function getToken(): string | null {
  return token ?? import.meta.env.VITE_DA_TOKEN ?? null;
}

export function setToken(t: string | null): void {
  token = t;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = getToken();
  if (!t) throw new Error('DA token not set; open this tool in da.live or set VITE_DA_TOKEN');
  return { Authorization: `Bearer ${t}`, ...extra };
}

export function parseDAPath(daPath: string): { org: string; repo: string; contentPath: string } {
  const parts = daPath.replace(/\.html$/, '').split('/').filter(Boolean);
  const [org, repo, ...rest] = parts;
  return { org, repo, contentPath: `/${rest.join('/')}` };
}

export function daPathToEditUrl(daPath: string): string {
  return `https://da.live/edit#${daPath.replace(/\.html$/, '')}`;
}

export function daPathToPreviewUrl(daPath: string): string {
  const { org, repo, contentPath } = parseDAPath(daPath);
  return `https://${BRANCH}--${repo}--${org}.aem.page${contentPath}`;
}

export function daPathToLiveUrl(daPath: string): string {
  const { org, repo, contentPath } = parseDAPath(daPath);
  return `https://${BRANCH}--${repo}--${org}.aem.live${contentPath}`;
}

/** www.adobe.com / www.stage.adobe.com URL for da-express-milo `/express/...` pages, else null. */
export function daPathToAdobeUrl(daPath: string, stage = false): string | null {
  const { org, repo, contentPath } = parseDAPath(daPath);
  if (org !== 'adobecom' || repo !== 'da-express-milo' || !contentPath.startsWith('/express/')) return null;
  return `https://www.${stage ? 'stage.' : ''}adobe.com${contentPath}`;
}

// ─── DA source API ────────────────────────────────────────────────────────────

export interface DaListItem {
  path: string;
  name?: string;
  ext?: string;
  lastModified?: number;
}

export async function listDirectory(dirPath: string, signal?: AbortSignal): Promise<DaListItem[]> {
  // The DA /list API returns ~1000 entries per page plus a `da-continuation-token` header while the
  // listing is truncated; follow it so large folders aren't silently cut to their first page.
  const items: DaListItem[] = [];
  let continuationToken: string | null = null;
  for (let guard = 0; guard < 100_000; guard++) {
    const headers = authHeaders();
    if (continuationToken) headers['da-continuation-token'] = continuationToken;
    const resp = await fetchWithRetry(`${DA_API}/list${dirPath}`, { headers, signal });
    if (!resp.ok) throw new Error(`list ${dirPath}: ${resp.status}`);
    items.push(...(await resp.json() as DaListItem[]));
    continuationToken = resp.headers.get('da-continuation-token');
    if (!continuationToken) break;
  }
  return items;
}

export interface CrawlResult {
  docs: DaListItem[];
  errors: { dirPath: string; message: string }[];
}

/** Breadth-first listing of every `.html` document under `rootPath`, one folder level at a time. */
export async function crawlDocs(
  rootPath: string,
  signal?: AbortSignal,
  onProgress?: (docsFound: number, foldersListed: number) => void,
): Promise<CrawlResult> {
  const docs: DaListItem[] = [];
  const errors: CrawlResult['errors'] = [];
  let folders = 0;
  let frontier = [rootPath];
  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    await runPool(frontier, async (dirPath) => {
      try {
        for (const item of await listDirectory(dirPath, signal)) {
          if (item.ext === undefined) nextFrontier.push(item.path);
          else if (item.ext === 'html') docs.push(item);
        }
      } catch (err) {
        if (err instanceof Error && (err.name === 'AuthError' || err.name === 'AbortError')) throw err;
        errors.push({ dirPath, message: err instanceof Error ? err.message : String(err) });
      }
      folders += 1;
      onProgress?.(docs.length, folders);
    }, 6, signal);
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    frontier = nextFrontier;
  }
  return { docs, errors };
}

export async function readSource(daPath: string, signal?: AbortSignal): Promise<string> {
  const resp = await fetchWithRetry(`${DA_API}/source${daPath}`, {
    cache: 'no-store',
    headers: authHeaders(),
    signal,
  });
  if (!resp.ok) throw new Error(`read: ${resp.status}`);
  return resp.text();
}

export async function writeSource(daPath: string, html: string, signal?: AbortSignal): Promise<void> {
  const body = new FormData();
  body.append('data', new Blob([html], { type: 'text/html' }));
  const resp = await fetchWithRetry(`${DA_API}/source${daPath}`, {
    method: 'POST',
    headers: authHeaders(),
    body,
    signal,
  });
  if (!resp.ok) throw new Error(`write: ${resp.status}`);
}

export async function createVersion(daPath: string, label: string, signal?: AbortSignal): Promise<void> {
  const resp = await fetchWithRetry(`${DA_API}/versionsource${daPath}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ label }),
    signal,
  });
  if (!resp.ok) throw new Error(`version: ${resp.status}`);
}

interface VersionEntry { label?: string; url?: string; timestamp?: number }

/** URL of the most recent DA version with this label, or null if there is none. */
export async function findVersionUrl(daPath: string, label: string, signal?: AbortSignal): Promise<string | null> {
  const resp = await fetchWithRetry(`${DA_API}/versionlist${daPath}`, { headers: authHeaders(), cache: 'no-store', signal });
  if (!resp.ok) throw new Error(`version list: ${resp.status}`);
  const list = await resp.json() as VersionEntry[];
  const match = list
    .filter((v) => v.label === label && v.url)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
  return match?.url ?? null;
}

/** Content of a version, given the `url` from the version list (e.g. `/versionsource/org/repo/id/vid.html`). */
export async function readVersion(url: string, signal?: AbortSignal): Promise<string> {
  const resp = await fetchWithRetry(`${DA_API}${url}`, { headers: authHeaders(), cache: 'no-store', signal });
  if (!resp.ok) throw new Error(`version read: ${resp.status}`);
  return resp.text();
}

// ─── AEM admin bulk jobs ─────────────────────────────────────────────────────

const STATUS_CHUNK = 1000;
const STATUS_RECONCILE_CHUNK = 100;
const STATUS_RECONCILE_ATTEMPTS = 2;
const MUTATE_CHUNK = 500;
const MUTATE_JOB_CONCURRENCY = 3;
const JOB_POLL_MS = 1500;
const JOB_POLL_MAX = 600;
const JOB_404_GRACE = 3;

export interface PathStatus {
  ok: boolean;
  sourceLastModified?: number;
  previewLastModified?: number;
  publishLastModified?: number;
}

type Progress = (done: number, total: number) => void;

function toEpoch(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

interface JobStart { job?: { name?: string; topic?: string }; links?: { self?: string } }
interface JobState { state?: string; progress?: { total?: number; processed?: number; failed?: number } }

async function startJob(
  org: string,
  repo: string,
  topic: 'status' | MutateTopic,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ jobUrl: string }> {
  const resp = await fetchWithRetry(`${HLX_ADMIN}/${topic}/${org}/${repo}/${BRANCH}/*`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw new Error(`${topic} job start: ${resp.status}`);
  const data = await resp.json() as JobStart;
  const name = data.job?.name ?? data.links?.self?.split('/').pop();
  if (!name) throw new Error(`${topic} job start: missing job name`);
  // A `/live/*` job is filed under topic "publish", so poll the topic the response reports.
  const jobTopic = data.job?.topic ?? topic;
  return { jobUrl: `${HLX_ADMIN}/job/${org}/${repo}/${BRANCH}/${jobTopic}/${name}` };
}

async function waitForJob(jobUrl: string, signal?: AbortSignal, onState?: (s: JobState) => void): Promise<JobState> {
  for (let attempt = 0; attempt < JOB_POLL_MAX; attempt++) {
    await sleep(JOB_POLL_MS, signal);
    const resp = await fetchWithRetry(jobUrl, { headers: authHeaders(), signal });
    if (resp.status === 404 && attempt < JOB_404_GRACE) continue;
    if (!resp.ok) throw new Error(`job poll: ${resp.status}`);
    const state = await resp.json() as JobState;
    onState?.(state);
    if (state.state === 'stopped' || state.state === 'completed') return state;
  }
  throw new Error('job did not finish in time');
}

interface StatusResource {
  path?: string; webPath?: string; resourcePath?: string;
  sourceLastModified?: string; previewLastModified?: string; publishLastModified?: string;
}

async function runStatusChunk(org: string, repo: string, contentPaths: string[], signal?: AbortSignal): Promise<Map<string, PathStatus>> {
  const { jobUrl } = await startJob(
    org, repo, 'status',
    { paths: contentPaths, select: ['edit', 'preview', 'live'], forceAsync: true },
    signal,
  );
  await waitForJob(jobUrl, signal);
  const resp = await fetchWithRetry(`${jobUrl}/details`, { headers: authHeaders(), signal });
  if (!resp.ok) throw new Error(`status details: ${resp.status}`);
  const details = await resp.json() as { data?: { resources?: unknown }; resources?: unknown };
  const resources = details.data?.resources ?? details.resources;
  if (!Array.isArray(resources)) throw new Error('status details: unrecognized shape');
  // Guards (kept from pdp-document-generator): if no resource carries a lifecycle timestamp, or most
  // requested paths are missing, the response shape changed. Throwing makes every doc "status
  // unknown" (skipped) instead of silently reading live pages as not live. For DA-backed sites the
  // job omits sourceLastModified even with select "edit"; callers fall back to DA's /list time.
  const out = new Map<string, PathStatus>();
  let recognized = false;
  for (const r of resources as StatusResource[]) {
    const path = r.path ?? r.webPath ?? r.resourcePath;
    if (!path) continue;
    const status: PathStatus = {
      ok: true,
      sourceLastModified: toEpoch(r.sourceLastModified),
      previewLastModified: toEpoch(r.previewLastModified),
      publishLastModified: toEpoch(r.publishLastModified),
    };
    if (status.sourceLastModified || status.previewLastModified || status.publishLastModified) recognized = true;
    out.set(path.replace(/\.md$/, ''), status);
  }
  if (resources.length > 0 && !recognized) throw new Error('status details: no lifecycle timestamps (unrecognized shape)');
  const requested = new Set(contentPaths);
  const foreign = [...out.keys()].filter((k) => !requested.has(k)).length;
  if (out.size > 0 && foreign > out.size * 0.5) throw new Error(`status details: path mismatch (${foreign}/${out.size} unrecognized)`);
  return out;
}

/**
 * Source/preview/publish timestamps for many DA paths via AEM bulk status jobs. The job can
 * silently drop paths (including never-previewed ones), so missing paths are re-run in small
 * batches, then probed on aem.live: a 404 there means not live. Anything else stays `{ ok: false }`.
 */
export async function bulkStatus(daPaths: string[], signal?: AbortSignal, onProgress?: Progress): Promise<Map<string, PathStatus>> {
  const result = new Map<string, PathStatus>();
  if (daPaths.length === 0) return result;
  const { org, repo } = parseDAPath(daPaths[0]);

  async function pass(paths: string[], chunkSize: number) {
    for (let i = 0; i < paths.length; i += chunkSize) {
      const chunk = paths.slice(i, i + chunkSize);
      const byContent = new Map(chunk.map((p) => [parseDAPath(p).contentPath, p]));
      const statuses = await runStatusChunk(org, repo, [...byContent.keys()], signal);
      for (const [cp, st] of statuses) {
        const da = byContent.get(cp);
        if (da) result.set(da, st);
      }
      onProgress?.(result.size, daPaths.length);
    }
  }

  await pass(daPaths, STATUS_CHUNK);
  for (let attempt = 0; attempt < STATUS_RECONCILE_ATTEMPTS; attempt++) {
    const missing = daPaths.filter((p) => !result.has(p));
    if (missing.length === 0) break;
    try {
      await pass(missing, STATUS_RECONCILE_CHUNK);
    } catch (err) {
      if (err instanceof Error && (err.name === 'AuthError' || err.name === 'AbortError')) throw err;
      break;
    }
  }
  const missing = daPaths.filter((p) => !result.has(p));
  await runPool(missing, async (p) => {
    try {
      const resp = await fetchWithRetry(daPathToLiveUrl(p), { method: 'HEAD', cache: 'no-store', signal });
      result.set(p, { ok: resp.status === 404 });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AuthError' || err.name === 'AbortError')) throw err;
      result.set(p, { ok: false });
    }
  }, 8, signal);
  return result;
}

export type MutateTopic = 'preview' | 'live';

/**
 * Trigger preview or publish for many DA paths via AEM bulk jobs (chunks of 500, 3 at a time). A
 * chunk whose job fails falls back to single-path requests. This only *triggers* the work; callers
 * confirm the outcome per path with `bulkStatus`, because the per-path job result is undocumented.
 */
export async function bulkMutate(
  topic: MutateTopic,
  daPaths: string[],
  signal?: AbortSignal,
  onProgress?: Progress,
  onLog?: (msg: string) => void,
): Promise<void> {
  if (daPaths.length === 0) return;
  const { org, repo } = parseDAPath(daPaths[0]);
  const chunks: string[][] = [];
  for (let i = 0; i < daPaths.length; i += MUTATE_CHUNK) chunks.push(daPaths.slice(i, i + MUTATE_CHUNK));
  const done = new Array<number>(chunks.length).fill(0);
  const report = () => onProgress?.(done.reduce((a, b) => a + b, 0), daPaths.length);

  await runPool(chunks, async (chunk, idx) => {
    const contentPaths = chunk.map((p) => parseDAPath(p).contentPath);
    try {
      const { jobUrl } = await startJob(
        org, repo, topic,
        { paths: contentPaths, forceAsync: true },
        signal,
      );
      const final = await waitForJob(jobUrl, signal, (s) => {
        done[idx] = s.progress?.processed ?? done[idx];
        report();
      });
      if (final.progress?.failed) onLog?.(`${topic} job ${idx + 1}/${chunks.length}: ${final.progress.failed} path(s) reported failed`);
    } catch (err) {
      if (err instanceof Error && (err.name === 'AuthError' || err.name === 'AbortError')) throw err;
      onLog?.(`${topic} job ${idx + 1}/${chunks.length} failed (${err instanceof Error ? err.message : err}); falling back to single-path requests`);
      await runPool(contentPaths, async (cp) => {
        try {
          await fetchWithRetry(`${HLX_ADMIN}/${topic}/${org}/${repo}/${BRANCH}${cp}`, {
            method: 'POST',
            headers: authHeaders(),
            signal,
          });
        } catch (e) {
          if (e instanceof Error && (e.name === 'AuthError' || e.name === 'AbortError')) throw e;
        }
      }, 3, signal);
    }
    done[idx] = chunk.length;
    report();
  }, MUTATE_JOB_CONCURRENCY, signal);
}

/** Authless GET of the live page's `.plain.html` (aem.live is purged on publish). */
export async function fetchLivePlain(daPath: string, signal?: AbortSignal): Promise<string | null> {
  const resp = await fetchWithRetry(`${daPathToLiveUrl(daPath)}.plain.html`, { cache: 'no-store', signal });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`live: ${resp.status}`);
  return resp.text();
}
