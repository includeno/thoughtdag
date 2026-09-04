import assert from 'node:assert/strict';
import { applyTransaction, createTransaction, snapshotOf, trimTransactionLog } from '../src/lib/transactions.ts';

const data = (question) => ({
  question,
  response: '',
  responses: [],
  responseIndex: -1,
  isCollapsed: false,
  isEditing: false,
  isEditingResponse: false,
  isLoading: false,
  tokenCount: 0,
  highlights: [],
  highlightMode: 'tag',
  attachments: [],
  excludedAttachmentIds: [],
  includedAttachmentIds: [],
  roleMode: 'inherit',
  isRoot: false,
  isBranch: false,
});

const a = { id: 'a', type: 'thought', position: { x: 0, y: 0 }, data: data('A') };
const b = { id: 'b', type: 'thought', position: { x: 0, y: 200 }, data: data('B') };
const emptyTaxonomy = { tags: [], nodeTypes: [] };
const before = snapshotOf({ nodes: [a], edges: [], organizationRelations: [], taxonomy: emptyTaxonomy });
const taxonomy = { tags: [{ id: 't1', name: 'Evidence', color: '#123456', createdAt: '2026-01-01T00:00:00.000Z' }], nodeTypes: [] };
const relation = { id: 'r1', sourceId: 'a', targetId: 'b', kind: 'parent', createdAt: '2026-01-01T00:00:00.000Z' };
const after = snapshotOf({ nodes: [a, b], edges: [], organizationRelations: [relation], taxonomy });

const change = createTransaction(before, after, { id: 'tx-1', at: '2026-01-01T00:00:00.000Z', label: 'fixture' });
assert.ok(change, 'a graph change creates a transaction');
assert.equal(change.beforeRevision, 0);
assert.equal(change.afterRevision, 1);
assert.deepEqual(applyTransaction(after, change, 'backward'), before, 'inverse restores exact before snapshot');
assert.deepEqual(applyTransaction(before, change, 'forward'), after, 'forward restores exact after snapshot');

const selectedOnly = snapshotOf({ nodes: [{ ...a, selected: true }], edges: [], organizationRelations: [], taxonomy: emptyTaxonomy });
assert.equal(createTransaction(before, selectedOnly), null, 'selection is transient and never enters durable history');

const measuredOnly = snapshotOf({
  nodes: [{ ...a, measured: { width: 520, height: 143 }, dragging: false }],
  edges: [],
  organizationRelations: [],
  taxonomy: emptyTaxonomy,
});
assert.equal(createTransaction(before, measuredOnly), null, 'runtime measurements never enter durable history');

const trimmed = trimTransactionLog([change], ['tx-1', 'missing'], ['missing']);
assert.deepEqual(trimmed.undoableIds, ['tx-1'], 'only retained change ids remain undoable');
assert.deepEqual(trimmed.redoableIds, [], 'dangling redo ids are removed');

const longLedger = Array.from({ length: 205 }, (_, index) => ({
  ...change,
  id: `tx-${index + 1}`,
  beforeRevision: index,
  afterRevision: index + 1,
}));
const longIds = longLedger.map((transaction) => transaction.id);
const retained = trimTransactionLog(longLedger, longIds, []);
assert.equal(retained.transactions.length, 205, 'the append-only ledger is never silently truncated');
assert.deepEqual(retained.undoableIds, longIds, 'every retained command remains undoable');

console.log('transaction tests: PASS');
