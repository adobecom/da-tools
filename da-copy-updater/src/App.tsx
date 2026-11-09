import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getToken } from './api/daApi';
import ConfirmModal, { type ConfirmState } from './components/ConfirmModal';
import { LogConsole, ProgressPanel, type LogLine, type ProgressState } from './components/Progress';
import { ResultsTable, TypeSummary } from './components/Results';
import { deleteRun, JournalWriter, listRuns, loadRun, saveRun, type RunMeta } from './engine/journal';
import { UPDATE_BUCKETS, type DocRecord } from './engine/model';
import { folderName, isDraftsRoot, normalizeRoot } from './engine/paths';
import { download, qaUrls, toCsv, toJson } from './engine/report';
import { PRINT_PDP_RETURNS_RULE as RULE } from './engine/rule';
import {
  applyUpdates, eligibleFor, previewUpdated, publishPreviewed, scan, verifyLive,
  type EngineEvent, type PhaseContext,
} from './engine/run';
import { isAbortError } from './lib/http';

type Phase = 'scan' | 'apply' | 'preview' | 'publish' | 'verify';

const DEFAULT_ROOT = '/adobecom/da-express-milo/drafts/maxn/document-generator';
const MAX_LOG_LINES = 2000;

const PHASE_FNS: Record<Exclude<Phase, 'scan'>, (ctx: PhaseContext) => Promise<void>> = {
  apply: applyUpdates,
  preview: previewUpdated,
  publish: publishPreviewed,
  verify: verifyLive,
};

async function requestWakeLock(): Promise<{ release: () => Promise<void> } | null> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    return (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    return null;
  }
}

function Step({ n, title, desc, note, children }: { n: number; title: string; desc: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Step {n}</div>
      <div className="mt-1 font-medium">{title}</div>
      <p className="mt-1 flex-1 text-xs text-gray-600">{desc}</p>
      <div className="mt-3 flex flex-wrap gap-2">{children}</div>
      {note && <p className="mt-2 text-xs text-gray-500">{note}</p>}
    </div>
  );
}

function Btn(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const { variant = 'primary', className = '', ...rest } = props;
  const styles = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700',
    secondary: 'border border-gray-300 bg-white text-gray-800 hover:bg-gray-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  }[variant];
  return <button {...rest} className={`rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`} />;
}

export default function App() {
  const hasToken = Boolean(getToken());
  const [input, setInput] = useState(DEFAULT_ROOT);
  const [run, setRun] = useState<RunMeta | null>(null);
  const recordsRef = useRef(new Map<string, DocRecord>());
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<Phase | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const progressRef = useRef<ProgressState | null>(null);
  const logsRef = useRef<LogLine[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const dirtyRef = useRef(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'paused'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [savedRuns, setSavedRuns] = useState<RunMeta[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const refreshRuns = useCallback(() => {
    listRuns().then(setSavedRuns).catch(() => setSavedRuns([]));
  }, []);
  useEffect(refreshRuns, [refreshRuns]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setVersion((v) => v + 1);
      setProgress(progressRef.current ? { ...progressRef.current } : null);
      setLogs([...logsRef.current]);
    }, 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!busy) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [busy]);

  const log = useCallback((level: LogLine['level'], msg: string) => {
    logsRef.current.push({ time: Date.now(), level, msg });
    if (logsRef.current.length > MAX_LOG_LINES) logsRef.current.splice(0, logsRef.current.length - MAX_LOG_LINES);
    dirtyRef.current = true;
  }, []);

  const emit = useCallback((e: EngineEvent) => {
    if (e.type === 'progress') {
      const prev = progressRef.current;
      const startedAt = prev && prev.label === e.label ? prev.startedAt : Date.now();
      progressRef.current = { label: e.label, done: e.done, total: e.total, startedAt };
    } else if (e.type === 'log') {
      log(e.level, e.msg);
    }
    dirtyRef.current = true;
  }, [log]);

  const records = useMemo(() => [...recordsRef.current.values()], [version]);
  const counts = useMemo(() => ({
    apply: eligibleFor('apply', records).length,
    preview: eligibleFor('preview', records).length,
    publish: eligibleFor('publish', records).length,
    verify: eligibleFor('verify', records).length,
    unfinished: records.filter((r) => r.stage === 'updated' && r.bucket === 'update-and-publish' || r.stage === 'previewed').length,
    sourceOnlyUpdated: records.filter((r) => r.stage === 'updated' && r.bucket === 'update-source-only').length,
  }), [records]);

  async function execute(phase: Phase, root: string) {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(phase);
    setNotice(null);
    const wake = await requestWakeLock();
    try {
      if (phase === 'scan') {
        const scanned = await scan(root, RULE, ac.signal, emit);
        const now = Date.now();
        const meta: RunMeta = { id: String(now), root, ruleId: RULE.id, createdAt: now, updatedAt: now, total: scanned.length };
        await saveRun(meta, scanned);
        recordsRef.current = new Map(scanned.map((r) => [r.path, r]));
        setRun(meta);
      } else if (run) {
        const journal = new JournalWriter(run);
        try {
          await PHASE_FNS[phase]({ rule: RULE, root, records: recordsRef.current, journal, signal: ac.signal, emit });
        } finally {
          await journal.close();
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AuthError') {
        const text = 'Your DA session expired. Reload this page in da.live, open this run from "Saved runs", and run the same step again. Completed work is saved.';
        setNotice({ kind: 'paused', text });
        log('error', text);
      } else if (isAbortError(err)) {
        log('warn', 'Paused. Completed work is saved; run the same step again to continue.');
      } else {
        const text = err instanceof Error ? err.message : String(err);
        setNotice({ kind: 'error', text });
        log('error', text);
      }
    } finally {
      await wake?.release().catch(() => {});
      abortRef.current = null;
      setBusy(null);
      dirtyRef.current = true;
      refreshRuns();
    }
  }

  async function start(phase: Phase) {
    let root: string;
    try {
      root = phase === 'scan' ? normalizeRoot(input) : run!.root;
    } catch (err) {
      setNotice({ kind: 'error', text: (err as Error).message });
      return;
    }
    if (phase === 'scan') setInput(root);
    if (!navigator.locks) return execute(phase, root);
    await navigator.locks.request(`da-copy-updater:${root}`, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        setNotice({ kind: 'error', text: 'Another tab is already running a step on this folder.' });
        return;
      }
      await execute(phase, root);
    });
  }

  function confirmScan() {
    if (run && counts.unfinished > 0) {
      setConfirm({
        title: 'Start a new scan?',
        body: (
          <p>
            The open run has <b>{counts.unfinished}</b> updated pages that are not published yet. A new scan
            lists them as "already updated" and won't publish them. Finish preview/publish first, or reopen
            this run later from "Saved runs".
          </p>
        ),
        confirmLabel: 'Scan anyway',
        onConfirm: () => { void start('scan'); },
      });
      return;
    }
    void start('scan');
  }

  function confirmApply() {
    if (!run) return;
    const live = eligibleFor('apply', records).filter((r) => r.bucket === 'update-and-publish').length;
    setConfirm({
      title: `Update ${counts.apply.toLocaleString()} documents?`,
      body: (
        <>
          <p>For each document in <code>{run.root}</code>: save a DA version labeled "{RULE.versionLabel}", replace
            "{RULE.find}" with "{RULE.replace}", and read it back to verify.</p>
          <p>{live.toLocaleString()} of them are live and will be previewed and published in the next steps. The other {(counts.apply - live).toLocaleString()} are not live and only get the source edit.</p>
          <p>Nothing is published in this step.</p>
        </>
      ),
      confirmLabel: 'Update documents',
      typeToConfirm: isDraftsRoot(run.root) ? undefined : folderName(run.root),
      onConfirm: () => { void start('apply'); },
    });
  }

  function confirmPublish() {
    if (!run) return;
    setConfirm({
      title: `Publish ${counts.publish.toLocaleString()} pages?`,
      body: (
        <>
          <p>Each page is re-checked first; any page edited or re-previewed by someone else since our update is skipped.</p>
          <p>Run pdp-render-checker on the QA URL list before publishing.</p>
        </>
      ),
      confirmLabel: 'Publish',
      danger: !isDraftsRoot(run.root),
      typeToConfirm: isDraftsRoot(run.root) ? undefined : folderName(run.root),
      onConfirm: () => { void start('publish'); },
    });
  }

  async function openRun(id: string) {
    const loaded = await loadRun(id);
    if (!loaded) return;
    recordsRef.current = new Map(loaded.records.sort((a, b) => a.path.localeCompare(b.path)).map((r) => [r.path, r]));
    setRun(loaded.meta);
    setInput(loaded.meta.root);
    progressRef.current = null;
    setNotice(null);
    log('info', `Opened saved run for ${loaded.meta.root} (${loaded.records.length} documents)`);
  }

  async function removeRun(id: string) {
    await deleteRun(id);
    if (run?.id === id) {
      setRun(null);
      recordsRef.current = new Map();
      dirtyRef.current = true;
    }
    refreshRuns();
  }

  const disabled = busy !== null || !hasToken;
  const idleNote = (n: number) => {
    if (!run || n > 0) return undefined;
    const sourceOnly = counts.sourceOnlyUpdated
      ? ` ${counts.sourceOnlyUpdated.toLocaleString()} updated documents weren't live before the run, so they only get the source edit.`
      : '';
    return `Nothing waiting here. Only pages that were live before the run are previewed and published.${sourceOnly}`;
  };
  const stamp = run ? `${folderName(run.root)}-${new Date(run.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}` : '';
  const qaRecords = records.filter((r) => r.stage === 'previewed' || r.stage === 'published');

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <h1 className="text-lg font-semibold">DA Copy Updater</h1>
          <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs ${hasToken ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
            <span className={`h-2 w-2 rounded-full ${hasToken ? 'bg-green-500' : 'bg-gray-400'}`} />
            {hasToken ? 'DA token connected' : 'No DA token — open in da.live, or set VITE_DA_TOKEN'}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 p-6">
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-sm">
            <span className="font-medium">Copy change:</span> in the <code>{RULE.blockClass}</code> block,{' '}
            <code>&lt;{RULE.element}&gt;{RULE.find}&lt;/{RULE.element}&gt;</code> →{' '}
            <code>&lt;{RULE.element}&gt;{RULE.replace}&lt;/{RULE.element}&gt;</code>
            {RULE.ticketUrl && <> · <a className="text-blue-700 hover:underline" href={RULE.ticketUrl} target="_blank" rel="noreferrer">{RULE.id}</a></>}
          </div>
          <label className="mt-4 block text-sm font-medium" htmlFor="root">DA folder</label>
          <div className="mt-1 flex gap-2">
            <input
              id="root"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy !== null}
              placeholder="/adobecom/da-express-milo/express/print/business-card"
              className="flex-1 rounded border border-gray-300 px-3 py-2 font-mono text-sm"
            />
          </div>
          <p className="mt-1 text-xs text-gray-500">A folder path or da.live URL. Run one product-type folder at a time.</p>
          {savedRuns.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-gray-700">Saved runs ({savedRuns.length})</summary>
              <ul className="mt-2 space-y-1">
                {savedRuns.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className={`break-all font-mono ${run?.id === r.id ? 'font-semibold' : ''}`}>{r.root}</span>
                    <span className="text-gray-500">{new Date(r.createdAt).toLocaleString()} · {r.total.toLocaleString()} docs</span>
                    <button disabled={busy !== null} className="text-blue-700 hover:underline disabled:opacity-40" onClick={() => { void openRun(r.id); }}>Open</button>
                    <button disabled={busy !== null} className="text-red-700 hover:underline disabled:opacity-40" onClick={() => { void removeRun(r.id); }}>Delete</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        {notice && (
          <div className={`rounded-lg border p-3 text-sm ${notice.kind === 'paused' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-red-300 bg-red-50 text-red-900'}`}>
            {notice.text}
          </div>
        )}
        {busy && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            <span>Running. Keep this tab open and visible. Progress is saved as it goes; if interrupted, reopen the run from "Saved runs" and run the same step again.</span>
            <Btn variant="secondary" onClick={() => abortRef.current?.abort()}>Pause</Btn>
          </div>
        )}

        <section className="grid gap-3 md:grid-cols-4">
          <Step n={1} title="Scan (dry run)" desc="Reads every document and sorts it into update / skip buckets. Changes nothing.">
            <Btn disabled={disabled} onClick={confirmScan}>{run ? 'Re-scan' : 'Scan'}</Btn>
          </Step>
          <Step n={2} title="Update documents" desc="Saves a DA version, edits the copy, and verifies each document. Not published yet.">
            <Btn disabled={disabled || !run || counts.apply === 0} onClick={confirmApply}>Update {counts.apply.toLocaleString()}</Btn>
          </Step>
          <Step n={3} title="Preview" desc="Bulk-previews updated live pages. Then QA them with pdp-render-checker." note={idleNote(counts.preview)}>
            <Btn disabled={disabled || counts.preview === 0} onClick={() => { void start('preview'); }}>Preview {counts.preview.toLocaleString()}</Btn>
            <Btn variant="secondary" disabled={qaRecords.length === 0} onClick={() => download(`qa-urls-${stamp}.txt`, qaUrls(qaRecords), 'text/plain')}>QA URLs</Btn>
          </Step>
          <Step n={4} title="Publish" desc="Re-checks each page, publishes, then confirms the new copy on aem.live." note={idleNote(counts.publish + counts.verify)}>
            <Btn variant={run && !isDraftsRoot(run.root) ? 'danger' : 'primary'} disabled={disabled || counts.publish === 0} onClick={confirmPublish}>Publish {counts.publish.toLocaleString()}</Btn>
            <Btn variant="secondary" disabled={disabled || counts.verify === 0} onClick={() => { void start('verify'); }}>Verify live {counts.verify.toLocaleString()}</Btn>
          </Step>
        </section>

        <ProgressPanel progress={progress} busy={busy !== null} />
        <LogConsole lines={logs} />

        {run && records.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                Results for <span className="font-mono">{run.root}</span>
                <span className="ml-2 font-normal text-gray-500">
                  {records.filter((r) => UPDATE_BUCKETS.has(r.bucket)).length.toLocaleString()} of {records.length.toLocaleString()} documents to update
                </span>
              </h2>
              <div className="flex gap-2">
                <Btn variant="secondary" onClick={() => download(`copy-update-${stamp}.csv`, toCsv(records), 'text/csv')}>Download CSV</Btn>
                <Btn variant="secondary" onClick={() => download(`copy-update-${stamp}.json`, toJson(records, run.root, RULE), 'application/json')}>Download JSON</Btn>
              </div>
            </div>
            <TypeSummary records={records} />
            <ResultsTable records={records} root={run.root} />
          </>
        )}
      </main>

      {confirm && <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
