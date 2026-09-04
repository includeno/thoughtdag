import { get as idbGet } from 'idb-keyval';
import { applyDomainMaintenance, flushPendingTransaction, useStore } from '../store';
import { useProjects, projectStorageKey } from '../store/projects';
import { collectVaultReferences, internNodes, internTransactions, gcVault } from './attachment-vault';
import type { ThoughtNode } from '../types';
import type { CanvasTransaction } from '../store/types';

// Store-aware vault plumbing lives in its own module: attachment-vault.ts
// is imported from inside the store's module graph (lib/attachments), so
// importing the store THERE would be circular. Only App boots these.

function hasInlinePdf(node: ThoughtNode): boolean {
  return !!node.data.attachments?.some((attachment) =>
    attachment.type === 'application/pdf' && !!attachment.content && !attachment.contentInVault
  );
}

function transactionHasInlinePdf(transaction: CanvasTransaction): boolean {
  return transaction.changes.nodes.some((change) =>
    (change.before ? hasInlinePdf(change.before) : false)
      || (change.after ? hasInlinePdf(change.after) : false)
  );
}

/** Older canvases carry PDF bytes inline — lighten the ACTIVE canvas and its
    retained recovery log once after hydration. This is a representation-only
    maintenance rewrite: it preserves revisions and both undo/redo cursors,
    and is explicitly kept outside the user transaction ledger. */
export async function migrateActiveCanvasToVault(): Promise<void> {
  // Flush a pending semantic edit before taking the maintenance snapshot.
  // In-flight extraction/generation is retried by App's normal subscription.
  if (!flushPendingTransaction()) return;
  const state = useStore.getState();
  const { nodes, edges, organizationRelations, taxonomy, transactions } = state;
  const migrateNodes = nodes.some(hasInlinePdf);
  const migrateTransactions = transactions.some(transactionHasInlinePdf);
  if (!migrateNodes && !migrateTransactions) return;

  const [internedNodes, internedTransactions] = await Promise.all([
    migrateNodes ? internNodes(nodes) : Promise.resolve(nodes),
    migrateTransactions ? internTransactions(transactions) : Promise.resolve(transactions),
  ]);

  // Guard against a project switch or user command racing the async vault IO.
  const latest = useStore.getState();
  if (latest.nodes !== nodes
    || latest.edges !== edges
    || latest.organizationRelations !== organizationRelations
    || latest.taxonomy !== taxonomy
    || latest.transactions !== transactions) return;

  if (migrateNodes && !applyDomainMaintenance({ nodes: internedNodes })) return;
  if (migrateTransactions) useStore.setState({ transactions: internedTransactions });
}

/** Boot sweep: collect every attachment id across ALL projects (persisted
    payloads + the live one), then drop unreferenced vault entries. */
export async function gcVaultAtBoot(): Promise<void> {
  try {
    const ids = new Set<string>();
    const live = useStore.getState();
    collectVaultReferences(live.nodes, live.transactions, ids);
    for (const p of useProjects.getState().projects) {
      const raw = await idbGet(projectStorageKey(p.id)).catch(() => null);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const nodes = (parsed?.state?.nodes ?? []) as ThoughtNode[];
      const transactions = (parsed?.state?.transactions ?? []) as CanvasTransaction[];
      collectVaultReferences(nodes, transactions, ids);
    }
    const swept = await gcVault(ids);
    if (swept > 0) console.info(`[thoughtdag] vault GC: swept ${swept} orphaned payload(s)`);
  } catch (err) {
    console.warn('[thoughtdag] vault GC failed:', err);
  }
}
