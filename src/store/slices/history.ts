import type { StateCreator } from 'zustand';
import type { CanvasTransaction, StoreState, HistorySlice, Snapshot } from '../types';
import { condenseGuard } from '../../lib/condense-guard';
import { applyTransaction, createTransaction, snapshotOf, trimTransactionLog } from '../../lib/transactions';

const EMPTY_SNAPSHOT: Snapshot = {
  nodes: [],
  edges: [],
  organizationRelations: [],
  taxonomy: { tags: [], nodeTypes: [] },
};

function historyMirror(snapshot: Snapshot, undoCount: number, redoCount: number): Snapshot[] {
  // Compatibility surface for the existing toolbar/debug API. Entries share
  // one immutable snapshot; durable undo data lives in transactions below.
  return Array.from({ length: undoCount + redoCount + 1 }, () => snapshot);
}

function compensationTransaction(
  current: Snapshot,
  next: Snapshot,
  options: Pick<CanvasTransaction, 'kind' | 'label' | 'targetId' | 'beforeRevision' | 'afterRevision'>,
): CanvasTransaction {
  return createTransaction(current, next, options) ?? {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...options,
    changes: { nodes: [], edges: [], organizationRelations: [] },
  };
}

export const createHistorySlice: StateCreator<StoreState, [], [], HistorySlice> = (set, get) => ({
  history: [EMPTY_SNAPSHOT],
  historyIndex: 0,
  transactions: [],
  undoableTransactionIds: [],
  redoableTransactionIds: [],
  revision: 0,

  pushHistory: (label = 'canvas.change') => {
    const state = get();
    const after = snapshotOf(state);
    const before = state.history[state.historyIndex] ?? state.history.at(-1) ?? EMPTY_SNAPSHOT;
    const transaction = createTransaction(before, after, {
      label,
      beforeRevision: state.revision,
      afterRevision: state.revision + 1,
    });
    if (!transaction) return;

    const trimmed = trimTransactionLog(
      [...state.transactions, transaction],
      [...state.undoableTransactionIds, transaction.id],
      [],
    );
    set({
      transactions: trimmed.transactions,
      undoableTransactionIds: trimmed.undoableIds,
      redoableTransactionIds: trimmed.redoableIds,
      history: historyMirror(after, trimmed.undoableIds.length, trimmed.redoableIds.length),
      historyIndex: trimmed.undoableIds.length,
      revision: transaction.afterRevision,
    });
  },

  undo: () => {
    if (condenseGuard()) return;
    // Commit a legacy/pre-only mutation before undoing so every reachable UI
    // path still becomes a durable transaction.
    get().pushHistory('canvas.pending');
    const state = get();
    const targetId = state.undoableTransactionIds.at(-1);
    if (!targetId) return;
    const target = state.transactions.find((transaction) => transaction.id === targetId && transaction.kind === 'change');
    if (!target) return;

    const current = snapshotOf(state);
    const reverted = applyTransaction(current, target, 'backward');
    // A schema migration can make an older command semantically empty (for
    // example, a legacy transaction containing only React Flow measurements).
    // Still advance the durable cursor with an explicit no-op compensation,
    // otherwise that entry would permanently block every older Undo.
    const compensation = compensationTransaction(current, reverted, {
      kind: 'undo',
      label: 'history.undo',
      targetId,
      beforeRevision: state.revision,
      afterRevision: state.revision + 1,
    });
    const trimmed = trimTransactionLog(
      [...state.transactions, compensation],
      state.undoableTransactionIds.slice(0, -1),
      [...state.redoableTransactionIds, targetId],
    );
    set({
      ...reverted,
      transactions: trimmed.transactions,
      undoableTransactionIds: trimmed.undoableIds,
      redoableTransactionIds: trimmed.redoableIds,
      history: historyMirror(reverted, trimmed.undoableIds.length, trimmed.redoableIds.length),
      historyIndex: trimmed.undoableIds.length,
      revision: compensation.afterRevision,
    });
    get().logEvent('undo');
  },

  redo: () => {
    if (condenseGuard()) return;
    const state = get();
    const targetId = state.redoableTransactionIds.at(-1);
    if (!targetId) return;
    const target = state.transactions.find((transaction) => transaction.id === targetId && transaction.kind === 'change');
    if (!target) return;

    const current = snapshotOf(state);
    const restored = applyTransaction(current, target, 'forward');
    const compensation = compensationTransaction(current, restored, {
      kind: 'redo',
      label: 'history.redo',
      targetId,
      beforeRevision: state.revision,
      afterRevision: state.revision + 1,
    });
    const trimmed = trimTransactionLog(
      [...state.transactions, compensation],
      [...state.undoableTransactionIds, targetId],
      state.redoableTransactionIds.slice(0, -1),
    );
    set({
      ...restored,
      transactions: trimmed.transactions,
      undoableTransactionIds: trimmed.undoableIds,
      redoableTransactionIds: trimmed.redoableIds,
      history: historyMirror(restored, trimmed.undoableIds.length, trimmed.redoableIds.length),
      historyIndex: trimmed.undoableIds.length,
      revision: compensation.afterRevision,
    });
    get().logEvent('redo');
  },
});
