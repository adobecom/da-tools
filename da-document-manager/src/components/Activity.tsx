import { useEffect, useRef, useState } from 'react';

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogLine {
  time: number;
  level: LogLevel;
  msg: string;
}

export interface ProgressCounter {
  label: string;
  value: number;
  tone: 'green' | 'gray' | 'amber' | 'red';
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

const COUNTER_TONE: Record<ProgressCounter['tone'], string> = {
  green: 'bg-green-100 text-green-800',
  gray: 'bg-gray-100 text-gray-700',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
};

/**
 * Shared progress bar for every long operation. `total` of 0 renders an indeterminate bar (e.g. while
 * discovering documents). Elapsed time and an ETA are tracked per label, so each phase restarts the clock.
 */
export function ProgressBar({
  label,
  done,
  total,
  counters,
}: {
  label: string;
  done: number;
  total: number;
  counters?: ProgressCounter[];
}) {
  const startRef = useRef<{ label: string; t: number }>({ label, t: Date.now() });
  if (startRef.current.label !== label) startRef.current = { label, t: Date.now() };
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  const elapsed = Date.now() - startRef.current.t;
  const eta = total > 0 && done > 0 && done < total ? (elapsed / done) * (total - done) : null;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-gray-200 px-4 py-3">
      <div className="flex items-center justify-between gap-3 text-sm text-gray-600">
        <span className="font-medium text-gray-700">{label}</span>
        <span className="tabular-nums text-gray-500">
          {total > 0 ? `${done.toLocaleString()} / ${total.toLocaleString()} · ${pct}%` : `${done.toLocaleString()} found`}
          {` · ${fmtDuration(elapsed)}`}
          {eta !== null ? ` · ~${fmtDuration(eta)} left` : ''}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full bg-blue-500 ${pct === null ? 'w-1/3 animate-pulse' : 'transition-[width] duration-200'}`}
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
      {counters && counters.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {counters.map((c) => (
            <span key={c.label} className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${COUNTER_TONE[c.tone]}`}>
              {c.label} {c.value.toLocaleString()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: 'text-gray-300',
  success: 'text-green-400',
  warn: 'text-amber-300',
  error: 'text-red-400',
};

/** Console-style activity log: timestamped, colour-coded, auto-scrolls unless the user scrolled up. */
export function ActivityLog({ lines, onClear }: { lines: LogLine[]; onClear: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, open]);

  function download() {
    const text = lines.map((l) => `${new Date(l.time).toISOString()} ${l.level.toUpperCase().padEnd(7)} ${l.msg}`).join('\n');
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `document-manager-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3 text-xs">
        <button type="button" onClick={() => setOpen((o) => !o)} className="font-medium text-gray-600 hover:text-gray-900 cursor-pointer">
          {open ? '▾' : '▸'} Activity log ({lines.length})
        </button>
        <button type="button" onClick={download} className="text-gray-500 hover:text-gray-800 cursor-pointer">Download</button>
        <button type="button" onClick={onClear} className="text-gray-500 hover:text-gray-800 cursor-pointer">Clear</button>
      </div>
      {open && (
        <div
          ref={ref}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="h-48 overflow-y-auto rounded-xl bg-gray-900 p-3 font-mono text-xs leading-5"
        >
          {lines.map((l, i) => (
            <div key={i} className={LEVEL_CLASS[l.level]}>
              <span className="text-gray-500">{new Date(l.time).toLocaleTimeString()} </span>{l.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
