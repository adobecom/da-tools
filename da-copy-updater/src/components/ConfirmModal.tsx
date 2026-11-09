import { useState } from 'react';

export interface ConfirmState {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  /** When set, the user must type this text to enable the confirm button. */
  typeToConfirm?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export default function ConfirmModal({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const ready = !state.typeToConfirm || typed.trim() === state.typeToConfirm;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{state.title}</h2>
        <div className="mt-3 space-y-2 text-sm text-gray-700">{state.body}</div>
        {state.typeToConfirm && (
          <label className="mt-4 block text-sm">
            Type <code className="rounded bg-gray-100 px-1 font-semibold">{state.typeToConfirm}</code> to confirm
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm"
            />
          </label>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50" onClick={onClose}>Cancel</button>
          <button
            disabled={!ready}
            className={`rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-40 ${state.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
            onClick={() => { onClose(); state.onConfirm(); }}
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
