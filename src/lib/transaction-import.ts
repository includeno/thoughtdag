import type { CanvasEvent, ThoughtEdge, ThoughtNode, OrganizationRelation } from '../types';
import type { CanvasTransaction, EntityChange, ProjectTaxonomy, Snapshot } from '../store/types';
import { applyTransaction, patchEntity } from './transactions';
import { findParentCycles } from './knowledge';

type EntityValidator<T extends { id: string }> = (value: unknown, name: string) => T;

export interface TransactionImportValidators {
  node: EntityValidator<ThoughtNode>;
  edge: EntityValidator<ThoughtEdge>;
  organizationRelation: EntityValidator<OrganizationRelation>;
  taxonomy: (value: unknown, name: string) => ProjectTaxonomy;
}

export interface ParsedTransactionLedger {
  transactions: CanvasTransaction[];
  undoableTransactionIds: string[];
  redoableTransactionIds: string[];
  revision: number;
}

type TransactionLedgerInput = {
  transactions?: unknown;
  undoableTransactionIds?: unknown;
  redoableTransactionIds?: unknown;
  revision?: unknown;
};

const CANVAS_EVENT_OPS = new Set([
  'ask', 'generate', 'edit-question', 'edit-response', 'regenerate',
  'delete', 'archive', 'unarchive', 'highlight-add', 'highlight-remove',
  'connect', 'disconnect', 'merge', 'weave', 'explore', 'fanout',
  'material-add', 'undo', 'redo', 'commit',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate semantic timeline entries at the same boundary used by Web and CLI imports. */
export function parseCanvasEvents(value: unknown): CanvasEvent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('events must be an array');
  return value.map((candidate, index) => {
    if (!isRecord(candidate)
      || !isNonEmptyString(candidate.t)
      || !isNonEmptyString(candidate.op)
      || !CANVAS_EVENT_OPS.has(candidate.op)
      || (candidate.id !== undefined && !isNonEmptyString(candidate.id))) {
      throw new Error(`events[${index}] is invalid`);
    }
    if (candidate.d !== undefined) {
      if (!isRecord(candidate.d)
        || Object.values(candidate.d).some((item) => (
          typeof item !== 'string'
          && typeof item !== 'boolean'
          && (typeof item !== 'number' || !Number.isFinite(item))
        ))) {
        throw new Error(`events[${index}].d is invalid`);
      }
    }
    return candidate as unknown as CanvasEvent;
  });
}

function validateEntityChanges<T extends { id: string }>(
  value: unknown,
  name: string,
  validateEntity: EntityValidator<T>,
): EntityChange<T>[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate) || !isNonEmptyString(candidate.id)) throw new Error(`${name}[${index}] is invalid`);
    const beforePresent = Object.prototype.hasOwnProperty.call(candidate, 'before');
    const afterPresent = Object.prototype.hasOwnProperty.call(candidate, 'after');
    const patches = candidate.patches;
    if (patches !== undefined) {
      if (beforePresent || afterPresent || !Array.isArray(patches)) throw new Error(`${name}[${index}] invalid patches`);
      const paths: string[][] = [];
      for (const patch of patches) {
        if (!isRecord(patch) || !Array.isArray(patch.path) || patch.path.length === 0
          || patch.path.some(key => typeof key !== 'string' || !key || ['__proto__', 'prototype', 'constructor'].includes(key))
          || patch.path[0] === 'id'
          || (patch.path[0] === 'data' && (patch.path.length === 1 || ['attachments', 'tagIds', 'customTypeId'].includes(patch.path[1])))
          || (!('before' in patch) && !('after' in patch))) throw new Error(`${name}[${index}] invalid patch path/value`);
        const path = patch.path as string[];
        if (paths.some(previous => previous.slice(0, Math.min(previous.length, path.length)).every((key, i) => key === path[i]))) {
          throw new Error(`${name}[${index}] overlapping patch paths`);
        }
        paths.push(path);
      }
    }
    if (!beforePresent && !afterPresent && patches === undefined) throw new Error(`${name}[${index}] has no before or after entity`);
    if (ids.has(candidate.id)) throw new Error(`Duplicate ${name} entity id: ${candidate.id}`);
    ids.add(candidate.id);
    if (beforePresent) {
      const before = validateEntity(candidate.before, `${name}[${index}].before`);
      if (before.id !== candidate.id) throw new Error(`${name}[${index}].before id does not match`);
    }
    if (afterPresent) {
      const after = validateEntity(candidate.after, `${name}[${index}].after`);
      if (after.id !== candidate.id) throw new Error(`${name}[${index}].after id does not match`);
    }
    for (const indexName of ['beforeIndex', 'afterIndex'] as const) {
      const entityIndex = candidate[indexName];
      if (entityIndex !== undefined
        && (typeof entityIndex !== 'number' || !Number.isInteger(entityIndex) || entityIndex < 0)) {
        throw new Error(`${name}[${index}].${indexName} must be a non-negative integer`);
      }
    }
    if (!beforePresent && patches === undefined && candidate.beforeIndex !== undefined) {
      throw new Error(`${name}[${index}].beforeIndex requires a before entity`);
    }
    if (!afterPresent && patches === undefined && candidate.afterIndex !== undefined) {
      throw new Error(`${name}[${index}].afterIndex requires an after entity`);
    }
    return candidate as unknown as EntityChange<T>;
  });
}

function parseTransactions(value: unknown, validators: TransactionImportValidators): CanvasTransaction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('transactions must be an array');
  const ids = new Set<string>();
  const changeIds = new Set<string>();
  let expectedRevision = 0;
  return value.map((candidate, index) => {
    if (!isRecord(candidate)
      || !isNonEmptyString(candidate.id)
      || !isNonEmptyString(candidate.at)
      || !isNonEmptyString(candidate.label)
      || (candidate.kind !== 'change' && candidate.kind !== 'undo' && candidate.kind !== 'redo')
      || !isRecord(candidate.changes)) {
      throw new Error(`transactions[${index}] is invalid`);
    }
    if (ids.has(candidate.id)) throw new Error(`Duplicate transaction id: ${candidate.id}`);
    const rawBeforeRevision = candidate.beforeRevision === undefined ? expectedRevision : candidate.beforeRevision;
    if (typeof rawBeforeRevision !== 'number' || !Number.isInteger(rawBeforeRevision)
      || rawBeforeRevision !== expectedRevision) {
      throw new Error(`transactions[${index}] has invalid revisions`);
    }
    const beforeRevision = rawBeforeRevision;
    const rawAfterRevision = candidate.afterRevision === undefined ? beforeRevision + 1 : candidate.afterRevision;
    if (typeof rawAfterRevision !== 'number' || !Number.isInteger(rawAfterRevision)
      || rawAfterRevision !== beforeRevision + 1) {
      throw new Error(`transactions[${index}] has invalid revisions`);
    }
    const afterRevision = rawAfterRevision;
    const nodes = validateEntityChanges(
      candidate.changes.nodes,
      `transactions[${index}].changes.nodes`,
      validators.node,
    );
    const edges = validateEntityChanges(
      candidate.changes.edges,
      `transactions[${index}].changes.edges`,
      validators.edge,
    );
    const organizationRelations = validateEntityChanges(
      candidate.changes.organizationRelations,
      `transactions[${index}].changes.organizationRelations`,
      validators.organizationRelation,
    );
    let taxonomy: { before: ProjectTaxonomy; after: ProjectTaxonomy } | undefined;
    if (candidate.changes.taxonomy !== undefined) {
      if (!isRecord(candidate.changes.taxonomy)
        || !Object.prototype.hasOwnProperty.call(candidate.changes.taxonomy, 'before')
        || !Object.prototype.hasOwnProperty.call(candidate.changes.taxonomy, 'after')) {
        throw new Error(`transactions[${index}].changes.taxonomy is invalid`);
      }
      taxonomy = {
        before: validators.taxonomy(
          candidate.changes.taxonomy.before,
          `transactions[${index}].changes.taxonomy.before`,
        ),
        after: validators.taxonomy(
          candidate.changes.taxonomy.after,
          `transactions[${index}].changes.taxonomy.after`,
        ),
      };
    }
    if (candidate.kind === 'change') {
      if (candidate.targetId !== undefined) throw new Error(`transactions[${index}] change cannot have targetId`);
      changeIds.add(candidate.id);
    } else if (!isNonEmptyString(candidate.targetId) || !changeIds.has(candidate.targetId)) {
      throw new Error(`transactions[${index}] references an unknown change transaction`);
    }
    ids.add(candidate.id);
    expectedRevision = afterRevision;
    return {
      ...candidate,
      beforeRevision,
      afterRevision,
      changes: {
        ...candidate.changes,
        nodes,
        edges,
        organizationRelations,
        ...(taxonomy ? { taxonomy } : {}),
      },
    } as unknown as CanvasTransaction;
  });
}

function parseTransactionIds(value: unknown, name: string, changeIds: ReadonlySet<string>): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => !isNonEmptyString(id))) {
    throw new Error(`${name} must be an array of transaction IDs`);
  }
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) throw new Error(`${name} contains duplicate IDs`);
  const unknown = ids.find((id) => !changeIds.has(id));
  if (unknown) throw new Error(`${name} references an unknown change transaction: ${unknown}`);
  return [...ids];
}

/** Parse the append-only transaction boundary before any project or vault write. */
export function parseTransactionLedger(
  input: TransactionLedgerInput,
  validators: TransactionImportValidators,
): ParsedTransactionLedger {
  const transactions = parseTransactions(input.transactions, validators);
  const changeIds = new Set(transactions
    .filter((transaction) => transaction.kind === 'change')
    .map((transaction) => transaction.id));
  const undoableTransactionIds = parseTransactionIds(
    input.undoableTransactionIds,
    'undoableTransactionIds',
    changeIds,
  );
  const redoableTransactionIds = parseTransactionIds(
    input.redoableTransactionIds,
    'redoableTransactionIds',
    changeIds,
  );
  const redoable = new Set(redoableTransactionIds);
  const overlap = undoableTransactionIds.find((id) => redoable.has(id));
  if (overlap) throw new Error(`Transaction ${overlap} cannot be both undoable and redoable`);
  const highestRevision = transactions.reduce(
    (highest, transaction) => Math.max(highest, transaction.afterRevision),
    0,
  );
  const revision = input.revision === undefined ? highestRevision : input.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision !== highestRevision) {
    throw new Error('revision must exactly match the transaction log');
  }
  return { transactions, undoableTransactionIds, redoableTransactionIds, revision };
}

function taxonomyIds(taxonomy: ProjectTaxonomy): { tags: Set<string>; nodeTypes: Set<string> } {
  return {
    tags: new Set(taxonomy.tags.map((tag) => tag.id)),
    nodeTypes: new Set(taxonomy.nodeTypes.map((nodeType) => nodeType.id)),
  };
}

function assertNodeClassification(node: ThoughtNode, name: string, taxonomy: ProjectTaxonomy): void {
  const ids = taxonomyIds(taxonomy);
  const unknownTag = (node.data.tagIds ?? []).find((id) => !ids.tags.has(id));
  if (unknownTag) throw new Error(`${name} references an unknown tag: ${unknownTag}`);
  if (node.data.customTypeId && !ids.nodeTypes.has(node.data.customTypeId)) {
    throw new Error(`${name} references an unknown type: ${node.data.customTypeId}`);
  }
}

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

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string' && record.position && record.data
    && typeof record.data === 'object' && !Array.isArray(record.data)
    && !Object.prototype.hasOwnProperty.call(record.data, 'tagIds')) {
    return canonicalJson({ ...record, data: { ...record.data, tagIds: [] } });
  }
  const normalized = Object.fromEntries(Object.keys(record)
    .filter((key) => !TRANSIENT_KEYS.has(key) && record[key] !== undefined)
    .sort()
    .map((key) => [key, canonicalJson(record[key])]));
  return normalized;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function assertUniqueIds<T extends { id: string }>(items: readonly T[], name: string): Map<string, T> {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (byId.has(item.id)) throw new Error(`${name} contains duplicate id: ${item.id}`);
    byId.set(item.id, item);
  }
  return byId;
}

function assertStructuralAcyclic(edges: readonly ThoughtEdge[], nodeIds: ReadonlySet<string>, name: string): void {
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const edge of edges) {
    if (!edge.data?.isCrossLink) outgoing.get(edge.source)!.push(edge.target);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of nodeIds) {
    if (visit(id)) throw new Error(`${name} contains a structural edge cycle`);
  }
}

function assertSnapshotIntegrity(snapshot: Snapshot, name: string): void {
  const nodesById = assertUniqueIds(snapshot.nodes, `${name}.nodes`);
  const edgeIds = new Set<string>();
  for (const [index, edge] of snapshot.edges.entries()) {
    if (edgeIds.has(edge.id)) throw new Error(`${name}.edges contains duplicate id: ${edge.id}`);
    if (edge.source === edge.target || !nodesById.has(edge.source) || !nodesById.has(edge.target)) {
      throw new Error(`${name}.edges[${index}] references an invalid endpoint`);
    }
    if (edge.data?.isOrganization === true) {
      throw new Error(`${name}.edges[${index}] is a render-only organization edge`);
    }
    edgeIds.add(edge.id);
  }
  assertStructuralAcyclic(snapshot.edges, new Set(nodesById.keys()), name);

  for (const [index, node] of snapshot.nodes.entries()) {
    assertNodeClassification(node, `${name}.nodes[${index}]`, snapshot.taxonomy);
  }

  const relationIds = new Set<string>();
  const relationPairs = new Set<string>();
  for (const [index, relation] of snapshot.organizationRelations.entries()) {
    const source = nodesById.get(relation.sourceId);
    const target = nodesById.get(relation.targetId);
    const pair = `${relation.kind}\u0000${relation.sourceId}\u0000${relation.targetId}`;
    if (!source || !target || source.data.stepKind === 'frame' || target.data.stepKind === 'frame') {
      throw new Error(`${name}.organizationRelations[${index}] references an invalid endpoint`);
    }
    if (relationIds.has(relation.id) || relationPairs.has(pair)) {
      throw new Error(`${name}.organizationRelations[${index}] is duplicated`);
    }
    relationIds.add(relation.id);
    relationPairs.add(pair);
  }
  const parentCycles = findParentCycles(snapshot.organizationRelations);
  if (parentCycles.length > 0) throw new Error(`${name} contains an organization parent cycle`);
}

function assertEntitySide<T extends { id: string }>(
  current: readonly T[],
  changes: readonly EntityChange<T>[],
  side: 'before' | 'after',
  name: string,
): void {
  const currentById = assertUniqueIds(current, name);
  for (const [index, change] of changes.entries()) {
    const expected = side === 'before' ? change.before : change.after;
    const expectedIndex = side === 'before' ? change.beforeIndex : change.afterIndex;
    const actual = currentById.get(change.id);
    if (change.patches) {
      if (!actual || !sameJson(actual, patchEntity(actual, change.patches, side))) {
        throw new Error(`${name}.changes[${index}].${side} is not continuous for entity ${change.id}`);
      }
      if (expectedIndex !== undefined && current.indexOf(actual) !== expectedIndex) throw new Error(`${name} inconsistent entity index`);
      continue;
    }
    if (!expected) {
      if (actual) throw new Error(`${name}.changes[${index}].${side} expects entity ${change.id} to be absent`);
      continue;
    }
    if (!actual || !sameJson(actual, expected)) {
      throw new Error(`${name}.changes[${index}].${side} is not continuous for entity ${change.id}`);
    }
    if (expectedIndex !== undefined && current.indexOf(actual) !== expectedIndex) {
      throw new Error(`${name}.changes[${index}].${side} has an inconsistent entity index`);
    }
  }
}

function assertTransactionSide(snapshot: Snapshot, transaction: CanvasTransaction, side: 'before' | 'after', name: string): void {
  assertEntitySide(snapshot.nodes, transaction.changes.nodes, side, `${name}.nodes`);
  assertEntitySide(snapshot.edges, transaction.changes.edges, side, `${name}.edges`);
  assertEntitySide(
    snapshot.organizationRelations,
    transaction.changes.organizationRelations,
    side,
    `${name}.organizationRelations`,
  );
  const taxonomy = transaction.changes.taxonomy?.[side];
  if (taxonomy && !sameJson(snapshot.taxonomy, taxonomy)) {
    throw new Error(`${name}.taxonomy.${side} is not continuous`);
  }
}

/**
 * Prove that an imported append-only ledger is reversible and that every
 * intermediate revision is a valid graph. This rejects references that only
 * happen to exist in an unrelated future or past snapshot.
 */
export function validateTransactionHistory(
  transactions: readonly CanvasTransaction[],
  current: Snapshot,
  validators?: TransactionImportValidators,
): void {
  const validateSnapshot = (snapshot: Snapshot, name: string) => {
    assertSnapshotIntegrity(snapshot, name);
    if (validators) {
      snapshot.nodes.forEach(node => validators.node(node, name));
      snapshot.edges.forEach(edge => validators.edge(edge, name));
      snapshot.organizationRelations.forEach(relation => validators.organizationRelation(relation, name));
    }
  };
  validateSnapshot(current, 'current');
  let baseline = current;
  for (let index = transactions.length - 1; index >= 0; index -= 1) {
    const transaction = transactions[index];
    assertTransactionSide(baseline, transaction, 'after', `transactions[${index}]`);
    baseline = applyTransaction(baseline, transaction, 'backward');
    validateSnapshot(baseline, `transactions[${index}].beforeSnapshot`);
  }

  let replayed = baseline;
  for (const [index, transaction] of transactions.entries()) {
    assertTransactionSide(replayed, transaction, 'before', `transactions[${index}]`);
    replayed = applyTransaction(replayed, transaction, 'forward');
    assertTransactionSide(replayed, transaction, 'after', `transactions[${index}]`);
    validateSnapshot(replayed, `transactions[${index}].afterSnapshot`);
  }
  if (!sameJson(replayed, current)) throw new Error('transaction log does not reproduce the current snapshot');
}
