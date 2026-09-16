import type { ThoughtEdge, ThoughtNode, OrganizationRelation } from '../types';
import type { CanvasTransaction, EntityChange, ProjectTaxonomy, Snapshot } from '../store/types';

type SnapshotSource = {
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
  organizationRelations: OrganizationRelation[];
  taxonomy: ProjectTaxonomy;
};

const TRANSIENT_KEYS = new Set([
  'selected',
  'measured',
  'dragging',
  'resizing',
  'isLoading',
  'isEditing',
  'isEditingResponse',
  'restreaming',
  'focusRole',
  'isExtracting',
]);

export function snapshotOf(source: SnapshotSource): Snapshot {
  return {
    nodes: source.nodes.map((node) => {
      const runtimeNode = node as ThoughtNode & { measured?: unknown; dragging?: boolean; resizing?: boolean };
      const attachments = (node.data.attachments ?? []).map((attachment) => (
        attachment.isExtracting ? { ...attachment, isExtracting: false } : attachment
      ));
      const needsCopy = !!node.selected || !!node.data.isLoading || !!node.data.isEditing
        || !!node.data.isEditingResponse || !!node.data.restreaming || !!node.data.focusRole
        || runtimeNode.measured !== undefined || runtimeNode.dragging !== undefined || runtimeNode.resizing !== undefined
        || attachments.some((attachment, index) => attachment !== node.data.attachments[index]);
      if (!needsCopy) return node;
      const clean = { ...node } as ThoughtNode & { measured?: unknown; dragging?: boolean; resizing?: boolean };
      delete clean.measured;
      delete clean.dragging;
      delete clean.resizing;
      const data = { ...node.data, isLoading: false, isEditing: false, isEditingResponse: false, restreaming: undefined, focusRole: undefined, attachments };
      return { ...clean, selected: false, data };
    }),
    edges: source.edges.map((edge) => {
      if (!edge.selected && !edge.data?.focusRole) return edge;
      return { ...edge, selected: false, data: edge.data ? { ...edge.data, focusRole: undefined } : edge.data };
    }),
    organizationRelations: source.organizationRelations,
    taxonomy: source.taxonomy,
  };
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function changedLeaves(before: unknown, after: unknown, path: string[] = []): NonNullable<EntityChange<never>['patches']> {
  if (before === after) return [];
  if (isRecord(before) && isRecord(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(key => !TRANSIENT_KEYS.has(key))
      .flatMap(key => changedLeaves(before[key], after[key], [...path, key]));
  }
  if (sameValue(before, after)) return [];
  return [{ path, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }];
}

export function patchEntity<T>(entity: T, patches: NonNullable<EntityChange<T>['patches']>, side: 'before' | 'after'): T {
  const result = { ...entity } as Record<string, unknown>;
  for (const patch of patches) {
    let target = result;
    for (const key of patch.path.slice(0, -1)) {
      if (!isRecord(target[key])) throw new Error('Invalid transaction patch path');
      target[key] = { ...target[key] };
      target = target[key] as Record<string, unknown>;
    }
    const key = patch.path.at(-1)!;
    if (patch[side] === undefined) delete target[key];
    else target[key] = patch[side];
  }
  return result as T;
}

function diffEntities<T extends { id: string }>(before: T[], after: T[]): EntityChange<T>[] {
  if (before === after) return [];
  const beforeById = new Map(before.map((item, index) => [item.id, { item, index }]));
  const afterById = new Map(after.map((item, index) => [item.id, { item, index }]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  const changes: EntityChange<T>[] = [];
  for (const id of ids) {
    const b = beforeById.get(id);
    const a = afterById.get(id);
    if (b?.item === a?.item && b?.index === a?.index) continue;
    if (b && a) {
      const patches = changedLeaves(b.item, a.item);
      if (!patches.length && b.index === a.index) continue;
      // Attachment migration and taxonomy reconciliation operate on whole
      // nodes. Keep those uncommon edits self-contained for existing tools.
      if (!patches.some(p => p.path[0] === 'data' && (p.path.length === 1
        || ['attachments', 'tagIds', 'customTypeId'].includes(p.path[1])))) {
        changes.push({ id, beforeIndex: b.index, afterIndex: a.index, patches });
        continue;
      }
    }
    changes.push({
      id,
      ...(b ? { before: b.item, beforeIndex: b.index } : {}),
      ...(a ? { after: a.item, afterIndex: a.index } : {}),
    });
  }
  return changes;
}

export function createTransaction(
  before: Snapshot,
  after: Snapshot,
  options: {
    label?: string;
    kind?: CanvasTransaction['kind'];
    targetId?: string;
    id?: string;
    at?: string;
    beforeRevision?: number;
    afterRevision?: number;
  } = {},
): CanvasTransaction | null {
  const nodes = diffEntities(before.nodes, after.nodes);
  const edges = diffEntities(before.edges, after.edges);
  const organizationRelations = diffEntities(before.organizationRelations, after.organizationRelations);
  const taxonomy = before.taxonomy === after.taxonomy
    ? undefined
    : { before: before.taxonomy, after: after.taxonomy };
  if (nodes.length === 0 && edges.length === 0 && organizationRelations.length === 0 && !taxonomy) return null;
  return {
    id: options.id ?? crypto.randomUUID(),
    at: options.at ?? new Date().toISOString(),
    beforeRevision: options.beforeRevision ?? 0,
    afterRevision: options.afterRevision ?? ((options.beforeRevision ?? 0) + 1),
    kind: options.kind ?? 'change',
    label: options.label ?? 'canvas.change',
    ...(options.targetId ? { targetId: options.targetId } : {}),
    changes: { nodes, edges, organizationRelations, ...(taxonomy ? { taxonomy } : {}) },
  };
}

function applyEntityChanges<T extends { id: string }>(
  current: T[],
  changes: EntityChange<T>[],
  direction: 'forward' | 'backward',
): T[] {
  if (changes.length === 0) return current;
  const changedIds = new Set(changes.map((change) => change.id));
  const next = current.filter((item) => !changedIds.has(item.id));
  const insertions = changes
    .map((change) => ({
      value: change.patches
        ? patchEntity(current.find(item => item.id === change.id)!, change.patches, direction === 'forward' ? 'after' : 'before')
        : direction === 'forward' ? change.after : change.before,
      index: direction === 'forward' ? change.afterIndex : change.beforeIndex,
    }))
    .filter((entry): entry is { value: T; index: number | undefined } => !!entry.value)
    .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
  for (const entry of insertions) {
    const index = Math.max(0, Math.min(entry.index ?? next.length, next.length));
    next.splice(index, 0, entry.value);
  }
  return next;
}

export function applyTransaction(
  current: Snapshot,
  transaction: CanvasTransaction,
  direction: 'forward' | 'backward',
): Snapshot {
  const taxonomyChange = transaction.changes.taxonomy;
  return {
    nodes: applyEntityChanges(current.nodes, transaction.changes.nodes, direction),
    edges: applyEntityChanges(current.edges, transaction.changes.edges, direction),
    organizationRelations: applyEntityChanges(
      current.organizationRelations,
      transaction.changes.organizationRelations,
      direction,
    ),
    taxonomy: taxonomyChange
      ? (direction === 'forward' ? taxonomyChange.after : taxonomyChange.before)
      : current.taxonomy,
  };
}

export function trimTransactionLog(
  transactions: CanvasTransaction[],
  undoableIds: string[],
  redoableIds: string[],
): { transactions: CanvasTransaction[]; undoableIds: string[]; redoableIds: string[] } {
  // The transaction ledger is append-only. Retention/compaction requires an
  // explicit checkpoint design; silently dropping old commands makes a
  // project's recovery boundary unknowable and can orphan compensation rows.
  const kept = transactions;
  const originalIds = new Set(kept.filter((transaction) => transaction.kind === 'change').map((transaction) => transaction.id));
  return {
    transactions: kept,
    undoableIds: undoableIds.filter((id) => originalIds.has(id)),
    redoableIds: redoableIds.filter((id) => originalIds.has(id)),
  };
}
