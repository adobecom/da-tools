import { runBatch, DEFAULT_CONCURRENCY, sleep } from '../lib/concurrency';
import { fetchWithRetry } from '../lib/http';
import { findSite } from '../sites';

const DA_API = 'https://admin.da.live';
const HLX_ADMIN = 'https://admin.hlx.page';
const BRANCH = 'main';

function parseDAPath(daPath: string): { org: string; repo: string; contentPath: string } {
  const parts = daPath.replace(/\.html$/, '').split('/').filter(Boolean);
  const [org, repo, ...rest] = parts;
  return { org, repo, contentPath: `/${rest.join('/')}` };
}

export function daPathToPreviewUrl(daPath: string): string {
  const { org, repo, contentPath } = parseDAPath(daPath);
  return `https://${BRANCH}--${repo}--${org}.aem.page${contentPath}`;
}

export function daPathToLiveUrl(daPath: string): string {
  const { org, repo, contentPath } = parseDAPath(daPath);
  return `https://${BRANCH}--${repo}--${org}.aem.live${contentPath}`;
}

export function daPathToProdUrl(daPath: string): string {
  const { org, repo, contentPath } = parseDAPath(daPath);
  const site = findSite(org, repo);
  return site ? `${site.productionOrigin}${contentPath}` : daPathToLiveUrl(daPath);
}

let token: string | null = null;

export function getToken(): string | null {
  return token ?? import.meta.env.VITE_DA_TOKEN ?? null;
}

export function setToken(t: string | null): void {
  token = t;
}

export interface PostDocResponse {
  source?: { editUrl?: string };
}

export async function postDoc(dest: string, html: string): Promise<PostDocResponse> {
  const t = getToken();
  if (!t) throw new Error('DA token not set; set VITE_DA_TOKEN or run from DA.live');
  const fullpath = `${DA_API}/source${dest}${dest.endsWith('.html') ? '' : '.html'}`;
  const blob = new Blob([html], { type: 'text/html' });
  const body = new FormData();
  body.append('data', blob);
  const resp = await fetchWithRetry(fullpath, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}` },
    body,
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`${resp.status}: ${errorText}`);
  }
  return resp.json() as Promise<PostDocResponse>;
}

export async function createDocVersion(dest: string, label: string): Promise<void> {
  const t = getToken();
  if (!t) throw new Error('DA token not set; set VITE_DA_TOKEN or run from DA.live');
  const path = dest.endsWith('.html') ? dest : `${dest}.html`;
  const resp = await fetchWithRetry(`${DA_API}/versionsource${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ label }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`version ${dest}: ${resp.status}: ${text}`);
  }
}

export async function docExists(daPath: string): Promise<boolean> {
  const t = getToken();
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (t) headers.Authorization = `Bearer ${t}`;
  const path = daPath.endsWith('.html') ? daPath : `${daPath}.html`;
  const resp = await fetchWithRetry(`${DA_API}/source${path}`, { method: 'HEAD', headers });
  if (resp.status === 404) return false;
  if (resp.ok) return true;
  throw new Error(`${resp.status}: ${daPath}`);
}

export async function cat(filePath: string): Promise<string> {
  const t = getToken();
  if (!t) throw new Error('DA token not set; set VITE_DA_TOKEN or run from DA.live');
  const path = filePath.endsWith('.html') ? filePath : `${filePath}.html`;
  const resp = await fetch(`${DA_API}/source${path}`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  return resp.text();
}

export interface DaListItem {
  path: string;
  ext?: string;
}

export async function listDirectory(dirPath: string): Promise<DaListItem[]> {
  const t = getToken();
  if (!t) throw new Error('DA token not set; set VITE_DA_TOKEN or run from DA.live');
  // The DA /list API is S3/R2-backed and lists ~1000 entries per folder at a time, returning a
  // `da-continuation-token` response header when the folder listing is truncated. Follow it until
  // the whole folder is read — otherwise a folder with >1000 direct children is silently cut to
  // its first page, pinning the scan at a fixed count no matter how many documents are added.
  const items: DaListItem[] = [];
  let continuationToken: string | null = null;
  for (let guard = 0; guard < 1_000_000; guard++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${t}` };
    if (continuationToken) headers['da-continuation-token'] = continuationToken;
    const resp = await fetchWithRetry(`${DA_API}/list${dirPath}`, { headers });
    if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
    const pageItems = await resp.json() as DaListItem[];
    items.push(...pageItems);
    continuationToken = resp.headers.get('da-continuation-token');
    if (!continuationToken) break;
  }
  return items;
}

/**
 * List a directory and return the set of existing HTML document paths in it (leading-slash, no
 * extension) — the form a candidate output path (see `rowToOutputPath`) can be tested against with
 * `.has(path)`. Filters to `ext === 'html'` so it matches `docExists`'s `slug.html` probe exactly:
 * sub-directories (`ext` undefined) and non-HTML siblings sharing a slug (e.g. `slug.json`) are
 * excluded, so neither a same-named folder nor a sibling asset ever reads as an existing document.
 * `listDirectory` is all-or-nothing (it throws on any non-ok page rather than returning partial
 * results), so callers get either a complete set or an exception to route to a per-path fallback.
 */
export async function listDirDocPaths(dirPath: string): Promise<Set<string>> {
  const items = await listDirectory(dirPath);
  return new Set(items.filter((i) => i.ext === 'html').map((i) => i.path));
}

export interface DirectoryCheckResult {
  valid: boolean;
  error?: string;
}

export async function checkDirectoryExists(dirPath: string): Promise<DirectoryCheckResult> {
  try {
    await listDirectory(dirPath);
    return { valid: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const is403 = msg.startsWith('403');
    const is404 = msg.startsWith('404');
    return {
      valid: false,
      error: is403
        ? "Access denied — you don't have permission to write to this directory"
        : is404
        ? 'Directory not found — confirm the path exists in DA before generating'
        : `Could not verify directory (${msg})`,
    };
  }
}

export async function fetchSheet(daPath: string): Promise<Record<string, string>[]> {
  const t = getToken();
  if (!t) throw new Error('DA token not set; set VITE_DA_TOKEN or run from DA.live');
  const path = daPath.endsWith('.json') ? daPath : `${daPath}.json`;
  const resp = await fetch(`${DA_API}/source${path}`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  const json = await resp.json() as { data?: Record<string, string>[] };
  return json.data ?? [];
}

// Convert any DA-related URL to an admin source path (/org/repo/path)
export function urlToSourcePath(url: string): string {
  if (url.includes('da.live')) {
    try {
      const u = new URL(url);
      if (u.hash.length > 1) {
        const fragment = u.hash.slice(1);
        return fragment.startsWith('/') ? fragment : `/${fragment}`;
      }
    } catch { /* fall through */ }
    const hashIdx = url.indexOf('#');
    if (hashIdx !== -1) {
      const fragment = url.substring(hashIdx + 1);
      return fragment.startsWith('/') ? fragment : `/${fragment}`;
    }
  }
  if (url.startsWith('/')) return url;
  // Relative path without scheme: org/repo/path
  if (!url.includes('://')) return `/${url}`;
  // AEM page/preview URL: https://main--repo--org.aem.page/path
  try {
    const u = new URL(url);
    const sub = u.hostname.split('.')[0];
    const parts = sub.split('--');
    const org = parts[parts.length - 1];
    const repo = parts[parts.length - 2];
    return `/${org}/${repo}${u.pathname}`;
  } catch {
    return url;
  }
}

export function extractPlaceholders(html: string): string[] {
  const matches = [...html.matchAll(/\{\{([^}]+)\}\}/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

export interface TemplateValidation {
  status: 'ready' | 'warning' | 'invalid';
  placeholders: string[];
  issues: string[];
}

export function validateTemplate(html: string): TemplateValidation {
  const issues: string[] = [];
  const placeholders = extractPlaceholders(html);

  if (!/<main[\s>]/i.test(html)) {
    issues.push('Missing <main> element — template may not be a valid DA document');
  }
  if (placeholders.length === 0) {
    issues.push('No {{placeholder}} tokens found — verify the template has substitution markers');
  }

  const isInvalid = issues.some((i) => i.includes('Missing <main>'));
  const status = isInvalid ? 'invalid' : issues.length > 0 ? 'warning' : 'ready';

  return { status, issues, placeholders };
}

export async function triggerPreview(daPath: string, token: string): Promise<void> {
  const { org, repo, contentPath } = parseDAPath(daPath);
  const resp = await fetchWithRetry(`${HLX_ADMIN}/preview/${org}/${repo}/${BRANCH}${contentPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`preview ${daPath}: ${resp.status}`);
}

export async function triggerPublish(daPath: string, token: string): Promise<void> {
  const { org, repo, contentPath } = parseDAPath(daPath);
  const resp = await fetchWithRetry(`${HLX_ADMIN}/live/${org}/${repo}/${BRANCH}${contentPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`publish ${daPath}: ${resp.status}`);
}

export async function triggerUnpublish(daPath: string, token: string): Promise<void> {
  const { org, repo, contentPath } = parseDAPath(daPath);
  const resp = await fetch(`${HLX_ADMIN}/live/${org}/${repo}/${BRANCH}${contentPath}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`unpublish ${daPath}: ${resp.status}`);
}

export async function deleteDocument(daPath: string, token: string): Promise<void> {
  const fullpath = `${DA_API}/source${daPath}${daPath.endsWith('.html') ? '' : '.html'}`;
  const resp = await fetch(fullpath, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`delete ${daPath}: ${resp.status}`);
}

export interface PageStatus {
  live: boolean;
  preview: boolean;
  /** False when the status check failed (rate-limited/unreachable); live/preview are then not meaningful. */
  ok: boolean;
}

export async function checkPageStatus(daPath: string, token: string): Promise<PageStatus> {
  const { org, repo, contentPath } = parseDAPath(daPath);
  const url = `${HLX_ADMIN}/status/${org}/${repo}/${BRANCH}${contentPath}`;
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      // Rate-limited or transient server error — back off and retry rather than silently
      // reporting the doc as "not published" (the AEM admin API throttles aggressively).
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < MAX_ATTEMPTS - 1) {
          const retryAfter = Number(resp.headers.get('retry-after'));
          const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 400 * 2 ** attempt;
          await sleep(backoffMs + Math.random() * 300);
          continue;
        }
        return { live: false, preview: false, ok: false };
      }
      if (!resp.ok) return { live: false, preview: false, ok: false };
      const data = await resp.json() as { live?: { status: number }; preview?: { status: number } };
      return { live: data.live?.status === 200, preview: data.preview?.status === 200, ok: true };
    } catch {
      // Network / CORS failure — the endpoint is unreachable from this origin, so retrying
      // is futile (and, at scale, catastrophically slow). Fail fast; the caller marks it Unknown.
      return { live: false, preview: false, ok: false };
    }
  }
  return { live: false, preview: false, ok: false };
}

export async function batchCheckStatus(
  paths: string[],
  token: string,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<Map<string, PageStatus>> {
  const results = new Map<string, PageStatus>();
  await runBatch(paths, async (p) => {
    results.set(p, await checkPageStatus(p, token));
  }, concurrency);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scalable status resolution: bulk status job (primary) → authless CDN HEAD (fallback).
//
// Replaces per-document GETs to admin.hlx.page/status, which is rate-limited to ~10 req/s per
// project and so mass-fails a ~6k-doc scan. The bulk job statuses the whole set in one async job;
// if it's unavailable or returns an unrecognized shape, we fall back to bodyless/authless HEAD
// probes of the live CDN (200 req/s host limit), which reliably determine "published".
// ─────────────────────────────────────────────────────────────────────────────

const BULK_STATUS_CHUNK = 1000;   // paths per bulk status job (primary pass — fast, few jobs)
const RECONCILE_CHUNK = 100;      // smaller batch for re-running dropped paths (the job drops fewer when small)
const RECONCILE_ATTEMPTS = 2;     // re-run the missing diff this many times before the HEAD net
const JOB_POLL_MS = 1000;         // delay between job-status polls
const JOB_POLL_MAX = 180;         // give up on a job after ~3 min → fall back
const HEAD_BATCH_SIZE = 20;       // paths probed in parallel per HEAD batch
const HEAD_BATCH_MS = 300;        // min ms per HEAD batch (paces well under the CDN's 200 req/s)

const BULK_MUTATE_CHUNK = 500;    // paths per preview/publish job (smaller than status: these RENDER pages)
const MUTATE_POLL_MAX = 300;      // give up on a mutate job after ~5 min → per-path fan-out
const MUTATE_JOB_CONCURRENCY = 3; // bulk job chunks run this many at once (≤3 pending/topic ≪ 500 cap; ~3 polls/s ≪ 10 req/s)
const JOB_404_GRACE = 3;          // tolerate a transient 404 on the first few polls (job not yet queryable)

type StatusProgress = (done: number, total: number) => void;

/**
 * Resolve publish/preview status for many docs without hammering the rate-limited admin status
 * API. Tries the AEM bulk status job first; on any failure/unsupported/unrecognized response it
 * falls back to authless CDN HEAD probes (reliable for "published").
 */
export async function resolveStatuses(
  paths: string[],
  token: string,
  onProgress?: StatusProgress,
): Promise<Map<string, PageStatus>> {
  if (paths.length === 0) return new Map();
  try {
    return await bulkResolveStatus(paths, token, onProgress);
  } catch {
    return await headResolveStatus(paths, onProgress);
  }
}

/**
 * Authless, bodyless HEAD probe of the live CDN: live = 200. The preview tier is often
 * auth-gated, so it isn't probed here — a not-live doc reads as Draft in this fallback.
 */
export async function headResolveStatus(
  paths: string[],
  onProgress?: StatusProgress,
): Promise<Map<string, PageStatus>> {
  const result = new Map<string, PageStatus>();
  for (let i = 0; i < paths.length; i += HEAD_BATCH_SIZE) {
    const batchStart = Date.now();
    const batch = paths.slice(i, i + HEAD_BATCH_SIZE);
    await Promise.all(batch.map(async (p) => {
      let live = false;
      try {
        const resp = await fetch(daPathToLiveUrl(p), { method: 'HEAD' });
        live = resp.ok;
      } catch { /* CDN unreachable → treat as not published */ }
      result.set(p, { live, preview: false, ok: true });
    }));
    if (onProgress) onProgress(Math.min(i + batch.length, paths.length), paths.length);
    const wait = HEAD_BATCH_MS - (Date.now() - batchStart);
    if (wait > 0 && i + HEAD_BATCH_SIZE < paths.length) await sleep(wait);
  }
  return result;
}

/**
 * Bulk status via the AEM admin job API. The job silently drops paths whose source-side lookup
 * transiently fails (counted in progress.failed, absent from resources) — more so in big batches,
 * and disproportionately for drafts (whose only signal is the source timestamp; a published doc
 * still surfaces via its preview/live timestamps). So after the fast primary pass we diff
 * requested-vs-returned and re-run the missing set in small batches (which the job resolves
 * reliably), then fall back to the authless HEAD probe for any residual — resolving the stragglers
 * up front instead of surfacing them as Unknown, while keeping the scan fast.
 */
export async function bulkResolveStatus(
  paths: string[],
  token: string,
  onProgress?: StatusProgress,
): Promise<Map<string, PageStatus>> {
  const { org, repo } = parseDAPath(paths[0]);
  const result = new Map<string, PageStatus>();
  const report = () => onProgress?.(Math.min(result.size, paths.length), paths.length);

  // Run a set of DA paths through the job in `chunkSize` chunks, merging results keyed by DA path.
  async function runPass(daPaths: string[], chunkSize: number): Promise<void> {
    for (let i = 0; i < daPaths.length; i += chunkSize) {
      const chunk = daPaths.slice(i, i + chunkSize);
      const contentToDa = new Map<string, string>();
      const contentPaths = chunk.map((p) => {
        const cp = parseDAPath(p).contentPath;
        contentToDa.set(cp, p);
        return cp;
      });
      const statuses = await runBulkStatusChunk(org, repo, contentPaths, token);
      for (const [cp, st] of statuses) {
        const da = contentToDa.get(cp);
        if (da) result.set(da, st);
      }
      report();
    }
  }

  // Primary pass — big chunks. May throw → resolveStatuses() falls back to full HEAD.
  await runPass(paths, BULK_STATUS_CHUNK);

  // Reconcile the paths the job dropped by re-running just those in small batches. Best-effort: a
  // hiccup here must never discard the good primary results.
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
    const missing = paths.filter((p) => !result.has(p));
    if (missing.length === 0) break;
    try {
      await runPass(missing, RECONCILE_CHUNK);
    } catch {
      break;
    }
  }

  // Final net: resolve any still-missing path via the authless CDN HEAD probe (reliable for
  // "published"), so a dropped-but-published doc is caught rather than mislabeled.
  const stillMissing = paths.filter((p) => !result.has(p));
  if (stillMissing.length > 0) {
    try {
      const headStatuses = await headResolveStatus(stillMissing);
      for (const [p, st] of headStatuses) result.set(p, st);
      report();
    } catch { /* fall through to Unknown */ }
  }

  // Anything the HEAD net couldn't reach either → genuinely Unknown (recheckable).
  for (const p of paths) if (!result.has(p)) result.set(p, { live: false, preview: false, ok: false });
  return result;
}

type BulkResource = {
  path?: string; webPath?: string; resourcePath?: string;
  // A bulk STATUS job reports lifecycle state as timestamps, present iff the doc exists in that
  // tier — NOT as `{ status: 200 }` objects (those belong to the single-path status endpoint).
  sourceLastModified?: string; previewLastModified?: string; publishLastModified?: string;
};

async function runBulkStatusChunk(
  org: string,
  repo: string,
  contentPaths: string[],
  token: string,
): Promise<Map<string, PageStatus>> {
  // 1. Start the async bulk status job for these paths.
  const startResp = await fetch(`${HLX_ADMIN}/status/${org}/${repo}/${BRANCH}/*`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: contentPaths, select: ['edit', 'preview', 'live'], forceAsync: true }),
  });
  if (!startResp.ok) throw new Error(`bulk status start: ${startResp.status}`);
  const startData = await startResp.json() as { job?: { name?: string }; links?: { self?: string } };
  const jobName = startData.job?.name ?? startData.links?.self?.split('/').pop();
  if (!jobName) throw new Error('bulk status: missing job name');

  // 2. Poll until the job stops.
  const jobUrl = `${HLX_ADMIN}/job/${org}/${repo}/${BRANCH}/status/${jobName}`;
  let stopped = false;
  for (let attempt = 0; attempt < JOB_POLL_MAX && !stopped; attempt++) {
    await sleep(JOB_POLL_MS);
    const jResp = await fetch(jobUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!jResp.ok) throw new Error(`bulk status poll: ${jResp.status}`);
    const jData = await jResp.json() as { state?: string };
    stopped = jData.state === 'stopped' || jData.state === 'completed';
  }
  if (!stopped) throw new Error('bulk status: job did not finish in time');

  // 3. Read per-path results. A bulk STATUS job's /details reports lifecycle state as timestamps
  // under data.resources[] — `publishLastModified` (⇒ live/published) and `previewLastModified`
  // (⇒ previewed), NOT `{ status: 200 }` (that shape is the single-path /status endpoint's, and
  // assuming it here is what silently marked every doc Draft). Confirmed against the AEM OpenAPI
  // `bulkStatus`/`getJobDetails` spec + the helix-mcp bulk-status parser. Two guards force a
  // fallback to the reliable HEAD probe rather than silently reporting Draft: a path-key mismatch
  // (keys don't match what we requested) and a field mismatch (no resource carries any known
  // lifecycle timestamp — i.e. the shape changed again).
  const dResp = await fetch(`${jobUrl}/details`, { headers: { Authorization: `Bearer ${token}` } });
  if (!dResp.ok) throw new Error(`bulk status details: ${dResp.status}`);
  const details = await dResp.json() as { data?: { resources?: unknown }; resources?: unknown };
  const resources = details.data?.resources ?? details.resources;
  if (!Array.isArray(resources)) throw new Error('bulk status: unrecognized details shape');
  const out = new Map<string, PageStatus>();
  let recognizedShape = false;
  for (const item of resources as BulkResource[]) {
    const path = item.path ?? item.webPath ?? item.resourcePath;
    if (!path) continue;
    if (item.sourceLastModified || item.previewLastModified || item.publishLastModified) {
      recognizedShape = true;
    }
    out.set(path, {
      live: Boolean(item.publishLastModified),
      preview: Boolean(item.previewLastModified),
      ok: true,
    });
  }
  if (resources.length > 0 && !recognizedShape) {
    console.warn('bulk status: unrecognized resource shape, falling back to HEAD probe', resources[0]);
    throw new Error('bulk status: unrecognized resource shape');
  }
  const matched = contentPaths.filter((cp) => out.has(cp)).length;
  if (matched < contentPaths.length * 0.5) {
    throw new Error(`bulk status: path-format mismatch (${matched}/${contentPaths.length})`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk preview / publish / unpublish via AEM Admin async JOBS (primary) → per-path fan-out (fallback).
//
// Replaces per-document POSTs to admin.hlx.page/preview|/live, which are rate-limited to ~10 req/s
// per project AND incur a CORS preflight per unique path (uncacheable — every doc path differs), so
// a ~15k-doc preview/publish is otherwise hours long. One job handles a whole chunk of paths in a
// single request + polls. Modeled on the bulk STATUS job above (runBulkStatusChunk).
//
// The per-path result shape in a preview/live job's /details is NOT publicly documented, so we do
// NOT trust it: after each job we reconcile the true per-path outcome via resolveStatuses (the same
// reliable bulk-status path the Document Manager scan uses). progress.failed only gates whether a
// chunk was "clean" (see runBulkMutate). Chunks run a few at a time (MUTATE_JOB_CONCURRENCY) — well
// under the 500-pending-jobs-per-topic cap and the 10 req/s admin limit — to cut wall-clock at scale.
// ─────────────────────────────────────────────────────────────────────────────

export interface BulkMutateOutcome {
  succeeded: Set<string>;              // DA paths confirmed at the target tier
  failed: Map<string, string>;         // DA path → reason (surfaced as row.error)
  progress: { total: number; processed: number; failed: number };
}

type MutateTopic = 'preview' | 'live';

// One chunk → one job. Returns how many paths the job reported failed. Throws (→ caller's per-path
// fan-out) on start/poll failure or timeout. Never throws on /details (that shape is undocumented).
async function runBulkMutateChunk(
  org: string,
  repo: string,
  topic: MutateTopic,
  contentPaths: string[],
  token: string,
  onProcessed: (processed: number, total: number) => void,
  deleteOp: boolean,
): Promise<{ failed: number }> {
  const body: Record<string, unknown> = { paths: contentPaths, forceAsync: true };
  if (deleteOp) body.delete = true;   // unpublish = POST /live/* with delete:true
  const startResp = await fetchWithRetry(`${HLX_ADMIN}/${topic}/${org}/${repo}/${BRANCH}/*`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!startResp.ok) throw new Error(`bulk ${topic} start: ${startResp.status}`);
  const startData = await startResp.json() as { job?: { name?: string; topic?: string }; links?: { self?: string } };
  const jobName = startData.job?.name ?? startData.links?.self?.split('/').pop();
  if (!jobName) throw new Error(`bulk ${topic}: missing job name`);

  // The job's poll topic is NOT the start-path segment: a `/live/*` (publish) start is filed under
  // topic "publish", not "live" — polling "live" 404s and drops the whole chunk to the slow fan-out.
  // Preview happens to match ("preview"). Use the topic the start response actually reports.
  const jobTopic = startData.job?.topic ?? topic;
  const jobUrl = `${HLX_ADMIN}/job/${org}/${repo}/${BRANCH}/${jobTopic}/${jobName}`;
  let stopped = false;
  let failed = 0;
  for (let attempt = 0; attempt < MUTATE_POLL_MAX && !stopped; attempt++) {
    await sleep(JOB_POLL_MS);
    const jResp = await fetchWithRetry(jobUrl, { headers: { Authorization: `Bearer ${token}` } });
    // A freshly-created job can 404 for a moment before it's queryable; tolerate that briefly.
    if (jResp.status === 404 && attempt < JOB_404_GRACE) continue;
    if (!jResp.ok) throw new Error(`bulk ${topic} poll: ${jResp.status}`);
    const jData = await jResp.json() as { state?: string; progress?: { total?: number; processed?: number; failed?: number } };
    const p = jData.progress ?? {};
    failed = p.failed ?? failed;
    onProcessed(p.processed ?? 0, p.total ?? contentPaths.length);
    stopped = jData.state === 'stopped' || jData.state === 'completed';
  }
  if (!stopped) throw new Error(`bulk ${topic}: job did not finish in time`);

  // Best-effort only: the per-path /details shape for preview/live jobs is undocumented, so we merely
  // observe it (to enable a future fast-path) and NEVER trust or throw on it — reconciliation via
  // resolveStatuses is the authority.
  try {
    const dResp = await fetchWithRetry(`${jobUrl}/details`, { headers: { Authorization: `Bearer ${token}` } });
    if (dResp.ok) {
      const details = await dResp.json() as { data?: { resources?: unknown }; resources?: unknown };
      const resources = details.data?.resources ?? details.resources;
      if (Array.isArray(resources) && resources.length > 0) {
        const first = resources[0] as Record<string, unknown>;
        if (!(first.path ?? first.webPath ?? first.resourcePath)) {
          console.warn(`bulk ${topic}: unrecognized /details resource shape`, first);
        }
      }
    }
  } catch { /* details is an optional signal; ignore */ }

  return { failed };
}

async function runBulkMutate(
  paths: string[],
  token: string,
  topic: MutateTopic,
  deleteOp: boolean,
  onProgress?: StatusProgress,
): Promise<BulkMutateOutcome> {
  if (paths.length === 0) {
    return { succeeded: new Set(), failed: new Map(), progress: { total: 0, processed: 0, failed: 0 } };
  }
  const { org, repo } = parseDAPath(paths[0]);
  const dedup = [...new Set(paths)];
  const grandTotal = dedup.length;
  const chunkClean = new Map<string, boolean>();  // path → its chunk's job completed with failed === 0
  let failedTotal = 0;

  // Split into chunks and run a few jobs concurrently (MUTATE_JOB_CONCURRENCY). Progress is the sum
  // of each chunk's reported processed count — JS is single-threaded, so the shared writes to
  // perChunkDone / failedTotal / chunkClean below are race-free.
  const chunks: string[][] = [];
  for (let i = 0; i < dedup.length; i += BULK_MUTATE_CHUNK) chunks.push(dedup.slice(i, i + BULK_MUTATE_CHUNK));
  const perChunkDone = new Array<number>(chunks.length).fill(0);
  const report = () => onProgress?.(Math.min(perChunkDone.reduce((a, b) => a + b, 0), grandTotal), grandTotal);

  await runBatch(chunks.map((chunk, idx) => ({ chunk, idx })), async ({ chunk, idx }) => {
    const contentPaths = chunk.map((p) => parseDAPath(p).contentPath);
    try {
      const { failed } = await runBulkMutateChunk(
        org, repo, topic, contentPaths, token,
        (proc) => { perChunkDone[idx] = proc; report(); },
        deleteOp,
      );
      failedTotal += failed;
      for (const p of chunk) chunkClean.set(p, failed === 0);
    } catch {
      // Chunk job failed / timed out → per-path fan-out via the existing single-path endpoints.
      // Reconciliation below still decides the true outcome; mark the chunk not-clean so an
      // unconfirmable path isn't optimistically passed.
      const trigger = deleteOp ? triggerUnpublish : topic === 'preview' ? triggerPreview : triggerPublish;
      await runBatch(chunk, async (p) => { try { await trigger(p, token); } catch { /* reconcile decides */ } }, DEFAULT_CONCURRENCY);
      for (const p of chunk) chunkClean.set(p, false);
    }
    perChunkDone[idx] = chunk.length;
    report();
  }, MUTATE_JOB_CONCURRENCY);

  // Reconcile the authoritative per-path outcome via the reliable bulk-status path.
  const status = await resolveStatuses(dedup, token);
  const succeeded = new Set<string>();
  const failed = new Map<string, string>();
  const label = deleteOp ? 'unpublish' : topic;
  for (const p of dedup) {
    const st = status.get(p);
    const confirmed = deleteOp
      ? (st?.ok === true && st.live === false)
      : topic === 'preview'
        ? (st?.ok === true && st.preview === true)
        : (st?.ok === true && st.live === true);
    if (confirmed) { succeeded.add(p); continue; }
    // Only some negatives are authoritative: the live tier is HEAD-verifiable, the preview tier is
    // not (headResolveStatus can't see it). A clean job over an otherwise-unverifiable path is trusted.
    const authoritativeFail = topic === 'preview'
      ? false
      : deleteOp
        ? (st?.ok === true && st.live === true)     // unpublish requested but still live → definitely failed
        : (st?.ok === true && st.live === false);   // publish requested but not live → definitely failed
    if (!authoritativeFail && chunkClean.get(p)) { succeeded.add(p); continue; }
    failed.set(p, `${label} not confirmed`);
  }
  return { succeeded, failed, progress: { total: grandTotal, processed: grandTotal, failed: failedTotal } };
}

export function bulkPreview(paths: string[], token: string, onProgress?: StatusProgress): Promise<BulkMutateOutcome> {
  return runBulkMutate(paths, token, 'preview', false, onProgress);
}
export function bulkPublish(paths: string[], token: string, onProgress?: StatusProgress): Promise<BulkMutateOutcome> {
  return runBulkMutate(paths, token, 'live', false, onProgress);
}
export function bulkUnpublish(paths: string[], token: string, onProgress?: StatusProgress): Promise<BulkMutateOutcome> {
  return runBulkMutate(paths, token, 'live', true, onProgress);
}

