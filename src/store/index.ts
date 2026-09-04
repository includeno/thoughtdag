import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createIdbObjectStorage, setBeforePersistenceFlush } from '../lib/persistence';
import { isViewerMode } from '../lib/viewer';
import type { ThoughtNode } from '../types';
import type { StoreState, PersistedState } from './types';
import { buildContext } from './context-builder';
import { createHistorySlice } from './slices/history';
import { createNodeSlice } from './slices/nodes';
import { createLlmSlice } from './slices/llm';
import { createRoleSlice } from './slices/roles';
import { createHighlightSlice } from './slices/highlights';
import { createAttachmentSlice } from './slices/attachments';
import { createEvaluatorSlice } from './slices/evaluator';
import { createEventSlice } from './slices/events';
import { createKnowledgeSlice } from './slices/knowledge';
import { snapshotOf, trimTransactionLog } from '../lib/transactions';

// Reset transient UI flags — applied both when persisting and when rehydrating,
// so a refresh mid-stream/mid-edit never restores a node stuck in loading state.
export function stripTransient(nodes: ThoughtNode[]): ThoughtNode[] {
  return nodes.map((n) => {
    const clean = { ...n } as ThoughtNode & { measured?: unknown; dragging?: boolean; resizing?: boolean };
    // React Flow owns these runtime measurements. Persisting them makes a
    // normal reload look like a user edit when fonts/badges settle at a
    // slightly different height, polluting the durable undo ledger.
    delete clean.measured;
    delete clean.dragging;
    delete clean.resizing;
    return {
      ...clean,
      selected: false,
      data: {
        ...n.data,
        isLoading: false,
        isEditing: false,
        isEditingResponse: false,
        restreaming: undefined,
        attachments: (n.data.attachments || []).map((attachment) =>
          attachment.isExtracting ? { ...attachment, isExtracting: false } : attachment
        ),
      },
    };
  });
}

export const useStore = create<StoreState>()(persist((...a) => ({
  ...createHistorySlice(...a),
  ...createNodeSlice(...a),
  ...createLlmSlice(...a),
  ...createRoleSlice(...a),
  ...createHighlightSlice(...a),
  ...createAttachmentSlice(...a),
  ...createEvaluatorSlice(...a),
  ...createEventSlice(...a),
  ...createKnowledgeSlice(...a),
}), {
  // Placeholder name — bootProjects() (src/store/projects.ts) points this at
  // the active project's key via persist.setOptions() before rehydrating.
  name: 'thoughtdag',
  version: 2,
  skipHydration: true,
  // Viewer mode is a guest session: nothing it does may touch local storage —
  // decided HERE at store creation so no early set() can race a later swap.
  storage: isViewerMode
    ? { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    : createIdbObjectStorage<PersistedState>(),
  // Persist project domain state plus the compact transaction ledger. The
  // compatibility `history` mirror and selection remain session-scoped; full
  // graph snapshots never enter IndexedDB.
  partialize: (state): PersistedState => ({
    nodes: stripTransient(state.nodes),
    edges: state.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
    events: state.events,
    organizationRelations: state.organizationRelations,
    taxonomy: state.taxonomy,
    transactions: state.transactions,
    undoableTransactionIds: state.undoableTransactionIds,
    redoableTransactionIds: state.redoableTransactionIds,
    revision: state.revision,
  }),
  migrate: (persisted): PersistedState => {
    const state = (persisted ?? {}) as Partial<PersistedState>;
    return {
      nodes: state.nodes ?? [],
      edges: state.edges ?? [],
      events: state.events ?? [],
      organizationRelations: state.organizationRelations ?? [],
      taxonomy: state.taxonomy ?? { tags: [], nodeTypes: [] },
      transactions: (state.transactions ?? []).map((transaction, index) => ({
        ...transaction,
        beforeRevision: transaction.beforeRevision ?? index,
        afterRevision: transaction.afterRevision ?? index + 1,
      })),
      undoableTransactionIds: state.undoableTransactionIds ?? [],
      redoableTransactionIds: state.redoableTransactionIds ?? [],
      revision: state.revision ?? state.transactions?.length ?? 0,
    };
  },
  merge: (persisted, current) => {
    const p = (persisted ?? { nodes: [], edges: [] }) as PersistedState;
    const nodes = stripTransient(p.nodes ?? []);
    const edges = (p.edges ?? []).map((e) => (e.selected ? { ...e, selected: false } : e));
    const organizationRelations = p.organizationRelations ?? [];
    const taxonomy = p.taxonomy ?? { tags: [], nodeTypes: [] };
    // File imports already use the v2 persist envelope, so Zustand does not
    // necessarily invoke `migrate()` for an older transaction payload. Make
    // revision normalization part of the merge boundary as well; this keeps
    // imported v1 history usable without mutating the source file.
    const transactions = (p.transactions ?? []).map((transaction, index) => ({
      ...transaction,
      beforeRevision: transaction.beforeRevision ?? index,
      afterRevision: transaction.afterRevision ?? index + 1,
    }));
    const trimmed = trimTransactionLog(
      transactions,
      p.undoableTransactionIds ?? [],
      p.redoableTransactionIds ?? [],
    );
    const revision = p.revision ?? trimmed.transactions.reduce(
      (highest, transaction) => Math.max(highest, transaction.afterRevision ?? 0),
      0,
    );
    const snapshot = snapshotOf({ nodes, edges, organizationRelations, taxonomy });
    const history = Array.from(
      { length: trimmed.undoableIds.length + trimmed.redoableIds.length + 1 },
      () => snapshot,
    );
    return {
      ...current,
      nodes,
      edges,
      events: p.events ?? [],
      organizationRelations,
      taxonomy,
      transactions: trimmed.transactions,
      undoableTransactionIds: trimmed.undoableIds,
      redoableTransactionIds: trimmed.redoableIds,
      // The compatibility history mirrors the durable transaction cursor.
      history,
      historyIndex: trimmed.undoableIds.length,
      revision,
    };
  },
  // Surface rehydration failures — zustand's hydrate() swallows them silently,
  // which would leave the app stuck behind the hydration gate.
  onRehydrateStorage: () => (_state, error) => {
    if (error) console.error('[thoughtdag] rehydration failed:', error);
  },
}));

// Staleness watcher: whenever the graph itself changes (any source — edits,
// generation, undo, project switch, rehydration), recompute which answers
// now predate their upstream. Debounced so streaming chunks coalesce.
let staleTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.nodes === prev.nodes && s.edges === prev.edges) return;
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => useStore.getState().recomputeStaleness(), 400);
});

// Durable transaction safety net. Legacy surfaces were written against the
// old snapshot history API and some still mutate after a pre-change
// pushHistory(). Coalesce any uncommitted graph change into one transaction;
// streaming stays transient until every active generation/extraction settles.
// Explicit post-change commits win synchronously and make this a no-op.
let transactionTimer: ReturnType<typeof setTimeout> | undefined;
let transactionCaptureSuppression = 0;

function graphHasInFlightWork(state: StoreState): boolean {
  return state.nodes.some((node) => node.data.isLoading || node.data.restreaming
    || node.data.attachments?.some((attachment) => attachment.isExtracting));
}

const commitSettledGraph = () => {
  transactionTimer = undefined;
  const state = useStore.getState();
  if (graphHasInFlightWork(state)) {
    transactionTimer = setTimeout(commitSettledGraph, 300);
    return;
  }
  state.pushHistory('canvas.auto');
};

/** Commit a coalesced legacy mutation before a durability boundary such as
    project switching, export, or backup. Returns false while generation or
    extraction is still in flight; the normal timer remains armed. */
export function flushPendingTransaction(label = 'canvas.pending'): boolean {
  if (transactionTimer) clearTimeout(transactionTimer);
  transactionTimer = undefined;
  const state = useStore.getState();
  if (graphHasInFlightWork(state)) {
    transactionTimer = setTimeout(commitSettledGraph, 300);
    return false;
  }
  state.pushHistory(label);
  return true;
}

/** Apply a representation-only maintenance rewrite (for example moving an
    inline PDF payload into the vault) without manufacturing a user command.
    The in-memory compatibility baseline is rebased to the rewritten state;
    durable transactions and their undo/redo cursor remain untouched. */
export function applyDomainMaintenance(
  patch: Partial<Pick<StoreState, 'nodes' | 'edges' | 'organizationRelations' | 'taxonomy'>>,
): boolean {
  if (!flushPendingTransaction()) return false;
  if (transactionTimer) clearTimeout(transactionTimer);
  transactionTimer = undefined;
  transactionCaptureSuppression++;
  try {
    useStore.setState(patch);
    const state = useStore.getState();
    const baseline = snapshotOf(state);
    useStore.setState({
      history: Array.from(
        { length: state.undoableTransactionIds.length + state.redoableTransactionIds.length + 1 },
        () => baseline,
      ),
      historyIndex: state.undoableTransactionIds.length,
    });
  } finally {
    transactionCaptureSuppression--;
  }
  return true;
}

useStore.subscribe((state, previous) => {
  if (transactionCaptureSuppression > 0) return;
  if (state.nodes === previous.nodes
    && state.edges === previous.edges
    && state.organizationRelations === previous.organizationRelations
    && state.taxonomy === previous.taxonomy) return;
  clearTimeout(transactionTimer);
  transactionTimer = setTimeout(commitSettledGraph, 300);
});

// Page hide and other forced storage flushes must serialize a graph and its
// transaction cursor from the same revision. The storage module calls this
// synchronously before it captures its pending value.
setBeforePersistenceFlush(() => { flushPendingTransaction('persistence.flush'); });

// Debug: expose store for testing (DEV only)
if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.assign(window, { __store: useStore, __buildContext: buildContext });
}
