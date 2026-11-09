import { useEffect, useRef } from 'react';
import type { LogLevel } from '../engine/run';

export interface ProgressState {
  label: string;
  done: number;
  total: number | null;
  startedAt: number;
}

export interface LogLine {
  time: number;
  level: LogLevel;
  msg: string;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function ProgressPanel({ progress, busy }: { progress: ProgressState | null; busy: boolean }) {
  if (!progress) return null;
  const { label, done, total, startedAt } = progress;
  const pct = total ? Math.min(100, (done / total) * 100) : null;
  const elapsed = Date.now() - startedAt;
  const eta = total && done > 0 && done < total ? (elapsed / done) * (total - done) : null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="font-medium">{busy ? label : `${label} (stopped)`}</span>
        <span className="tabular-nums text-gray-600">
          {total !== null ? `${done.toLocaleString()} / ${total.toLocaleString()}` : `${done.toLocaleString()} found`}
          {' · '}{fmtDuration(elapsed)} elapsed{eta !== null && busy ? ` · ~${fmtDuration(eta)} left` : ''}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100">
        {pct !== null
          ? <div className="h-full rounded-full bg-blue-600 transition-[width] duration-300" style={{ width: `${pct}%` }} />
          : <div className={`h-full w-1/3 rounded-full bg-blue-400 ${busy ? 'animate-pulse' : ''}`} />}
      </div>
    </div>
  );
}

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: 'text-gray-300',
  success: 'text-green-400',
  warn: 'text-amber-300',
  error: 'text-red-400',
};

export function LogConsole({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="h-56 overflow-y-auto rounded-lg bg-gray-900 p-3 font-mono text-xs leading-5"
    >
      {lines.length === 0 && <div className="text-gray-500">Log output appears here.</div>}
      {lines.map((l, i) => (
        <div key={i} className={LEVEL_CLASS[l.level]}>
          <span className="text-gray-500">{new Date(l.time).toLocaleTimeString()} </span>{l.msg}
        </div>
      ))}
    </div>
  );
}
