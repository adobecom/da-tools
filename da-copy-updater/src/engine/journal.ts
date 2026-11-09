import type { DocRecord } from './model';

// Persists each run in IndexedDB so a closed tab, reload, or expired token never strands pages
// that were updated but not yet previewed/published. Writes are batched to keep a 44k-doc run cheap.

export interface RunMeta {
  id: string;
  root: string;
  ruleId: string;
  createdAt: number;
  updatedAt: number;
  total: number;
}

const DB_NAME = 'da-copy-updater';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('runs', { keyPath: 'id' });
      const docs = db.createObjectStore('docs', { keyPath: ['runId', 'path'] });
      docs.createIndex('runId', 'runId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveRun(meta: RunMeta, records: Iterable<DocRecord>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['runs', 'docs'], 'readwrite');
  tx.objectStore('runs').put(meta);
  const docs = tx.objectStore('docs');
  for (const r of records) docs.put({ ...r, runId: meta.id });
  await done(tx);
}

export async function listRuns(): Promise<RunMeta[]> {
  const db = await openDb();
  const tx = db.transaction('runs', 'readonly');
  const req = tx.objectStore('runs').getAll();
  await done(tx);
  return (req.result as RunMeta[]).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadRun(id: string): Promise<{ meta: RunMeta; records: DocRecord[] } | null> {
  const db = await openDb();
  const tx = db.transaction(['runs', 'docs'], 'readonly');
  const metaReq = tx.objectStore('runs').get(id);
  const docsReq = tx.objectStore('docs').index('runId').getAll(id);
  await done(tx);
  if (!metaReq.result) return null;
  const records = (docsReq.result as (DocRecord & { runId?: string })[]).map(({ runId: _runId, ...r }) => r);
  return { meta: metaReq.result as RunMeta, records };
}

export async function deleteRun(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['runs', 'docs'], 'readwrite');
  tx.objectStore('runs').delete(id);
  tx.objectStore('docs').delete(IDBKeyRange.bound([id, ''], [id, '\uffff']));
  await done(tx);
}

/** Queues per-document updates and writes them in one transaction every second. */
export class JournalWriter {
  private pending = new Map<string, DocRecord>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private meta: RunMeta;

  constructor(meta: RunMeta) {
    this.meta = meta;
  }

  put(record: DocRecord): void {
    this.pending.set(record.path, record);
    this.timer ??= setInterval(() => { void this.flush(); }, 1000);
  }

  /** Write one record immediately (used right before a document is modified). */
  async putNow(record: DocRecord): Promise<void> {
    this.pending.delete(record.path);
    await saveRun({ ...this.meta, updatedAt: Date.now() }, [record]);
  }

  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.meta = { ...this.meta, updatedAt: Date.now() };
    await saveRun(this.meta, batch);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
