#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

globalThis.__THOUGHTDAG_TEST_IDB__ = new Map();
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.location = {
  hostname: 'localhost',
  protocol: 'http:',
  hash: '',
  href: 'http://localhost:5173/',
  origin: 'http://localhost:5173',
};
globalThis.window = {
  location: globalThis.location,
  addEventListener: () => {},
};
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: () => {},
};

const idbAlias = fileURLToPath(new URL('./fixtures/idb-keyval-memory.mjs', import.meta.url));
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
  resolve: { alias: { 'idb-keyval': idbAlias } },
});

const emptyTaxonomy = { tags: [], nodeTypes: [] };

function node(id, question) {
  return {
    id,
    type: 'thought',
    position: { x: 0, y: 0 },
    data: {
      question,
      response: '',
      responses: [],
      responseIndex: -1,
      isCollapsed: false,
      isEditing: false,
      isEditingResponse: false,
      isLoading: false,
      stepKind: 'note',
      tokenCount: 0,
      highlights: [],
      highlightMode: 'tag',
      attachments: [],
      excludedAttachmentIds: [],
      includedAttachmentIds: [],
      roleMode: 'inherit',
      isRoot: false,
      isBranch: false,
    },
  };
}

function persistedState(nodes) {
  return {
    state: {
      nodes,
      edges: [],
      events: [],
      organizationRelations: [],
      taxonomy: emptyTaxonomy,
      transactions: [],
      undoableTransactionIds: [],
      redoableTransactionIds: [],
      revision: 0,
    },
    version: 2,
  };
}

try {
  const [storeModule, projectsModule, persistenceModule, transactionModule, executorModule] = await Promise.all([
    vite.ssrLoadModule('/src/store/index.ts'),
    vite.ssrLoadModule('/src/store/projects.ts'),
    vite.ssrLoadModule('/src/lib/persistence.ts'),
    vite.ssrLoadModule('/src/lib/transactions.ts'),
    vite.ssrLoadModule('/src/lib/cli-executor.ts'),
  ]);
  const { flushPendingTransaction, useStore } = storeModule;
  const { projectStorageKey, switchProject, useProjects } = projectsModule;
  const { flushPendingWrites } = persistenceModule;
  const { snapshotOf } = transactionModule;
  const { executeCliCommand } = executorModule;

  const sourceNode = node('source-node', 'before');
  const targetNode = node('target-node', 'target');
  const sourceSnapshot = snapshotOf({
    nodes: [sourceNode],
    edges: [],
    organizationRelations: [],
    taxonomy: emptyTaxonomy,
  });
  useProjects.setState({
    projects: [
      { id: 'source', name: 'Source', createdAt: 1, updatedAt: 1 },
      { id: 'target', name: 'Target', createdAt: 2, updatedAt: 2 },
    ],
    activeId: 'source',
    switching: false,
  });
  useStore.persist.setOptions({ name: projectStorageKey('source') });
  useStore.setState({
    nodes: [sourceNode],
    edges: [],
    events: [],
    organizationRelations: [],
    taxonomy: emptyTaxonomy,
    transactions: [],
    undoableTransactionIds: [],
    redoableTransactionIds: [],
    revision: 0,
    history: [sourceSnapshot],
    historyIndex: 0,
  });
  assert.equal(flushPendingTransaction(), true);
  await flushPendingWrites();
  globalThis.__THOUGHTDAG_TEST_IDB__.set(projectStorageKey('target'), persistedState([targetNode]));

  // Reproduce a legacy surface: push before mutation, then switch before the
  // 300 ms safety-net timer fires. The outgoing persisted graph and ledger
  // must cross the project boundary together.
  useStore.getState().pushHistory('legacy.pre-change');
  useStore.setState({ nodes: [{ ...sourceNode, data: { ...sourceNode.data, question: 'edited before switch' } }] });
  await switchProject('target');
  const storedSource = globalThis.__THOUGHTDAG_TEST_IDB__.get(projectStorageKey('source'));
  assert.equal(storedSource.state.nodes[0].data.question, 'edited before switch');
  assert.equal(storedSource.state.transactions.length, 1);
  assert.equal(storedSource.state.undoableTransactionIds.length, 1);
  assert.equal(storedSource.state.revision, 1);

  await switchProject('source');
  assert.equal(useStore.getState().nodes[0].data.question, 'edited before switch');
  useStore.getState().undo();
  assert.equal(useStore.getState().nodes[0].data.question, 'before', 'refresh/project rehydrate keeps the edit undoable');

  // A pagehide/visibility flush reaches the storage layer before the 300 ms
  // coalescer too. Its pre-flush hook must advance the ledger first.
  const beforeForcedFlush = useStore.getState().nodes[0];
  useStore.getState().pushHistory('legacy.pre-pagehide');
  useStore.setState({
    nodes: [{ ...beforeForcedFlush, data: { ...beforeForcedFlush.data, question: 'edited before forced flush' } }],
  });
  await flushPendingWrites();
  const afterForcedFlush = globalThis.__THOUGHTDAG_TEST_IDB__.get(projectStorageKey('source'));
  assert.equal(afterForcedFlush.state.nodes[0].data.question, 'edited before forced flush');
  assert.equal(afterForcedFlush.state.revision, useStore.getState().revision);
  assert.deepEqual(afterForcedFlush.state.transactions, useStore.getState().transactions);

  // A transfer request is another durability boundary. Its graph and ledger
  // must describe the same revision even when called immediately after edit.
  const beforeTransfer = useStore.getState().nodes[0];
  useStore.getState().pushHistory('legacy.pre-transfer');
  useStore.setState({
    nodes: [{ ...beforeTransfer, data: { ...beforeTransfer.data, question: 'edited before transfer' } }],
  });
  const transfer = await executeCliCommand('canvas.get', {});
  assert.equal(transfer.nodes[0].data.question, 'edited before transfer');
  assert.equal(transfer.revision, useStore.getState().revision);
  assert.deepEqual(transfer.transactions, useStore.getState().transactions);
  assert.deepEqual(transfer.undoableTransactionIds, useStore.getState().undoableTransactionIds);

  const busyNode = useStore.getState().nodes[0];
  useStore.setState({ nodes: [{ ...busyNode, data: { ...busyNode.data, isLoading: true } }] });
  await assert.rejects(
    () => executeCliCommand('canvas.export', {}),
    /unavailable while generation or extraction is in progress/,
    'a transfer must not serialize a partial stream with a stale transaction ledger',
  );
  useStore.setState({ nodes: [{ ...busyNode, data: { ...busyNode.data, isLoading: false } }] });
  flushPendingTransaction();

  // Editing mode is durable and independent of taxonomy, wires and answer history.
  await useStore.getState().addQuestion('Manual draft', { editMode: 'manual' });
  const manualId = useStore.getState().selectedNodeId;
  const currentNode = () => useStore.getState().nodes.find((n) => n.id === manualId);
  assert.equal(currentNode().data.editMode, 'manual');
  assert.equal(currentNode().data.isLoading, false);
  assert.equal(currentNode().data.response, '');
  await useStore.getState().editQuestion(manualId, 'Saved without AI');
  assert.equal(currentNode().data.question, 'Saved without AI');
  assert.equal(currentNode().data.isLoading, false);
  assert.ok(currentNode().data.tokenCount > 0);
  await useStore.getState().rerunNode(manualId, { auto: true });
  assert.equal(currentNode().data.response, '', 'automatic replay cannot generate on a manual node');
  const graphBeforeMode = useStore.getState();
  useStore.getState().setNodeEditMode(manualId, 'ai');
  assert.equal(currentNode().data.editMode, 'ai');
  assert.equal(currentNode().data.isLoading, false, 'switching alone never generates');
  assert.equal(currentNode().data.question, 'Saved without AI');
  assert.equal(useStore.getState().edges, graphBeforeMode.edges);
  assert.equal(useStore.getState().taxonomy, graphBeforeMode.taxonomy);
  useStore.getState().undo();
  assert.equal(currentNode().data.editMode, 'manual');
  useStore.getState().redo();
  assert.equal(currentNode().data.editMode, 'ai');
  await flushPendingWrites();
  await useStore.persist.rehydrate();
  assert.equal(currentNode().data.editMode, 'ai', 'mode survives rehydration');

  const answered = { ...currentNode(), data: {
    ...currentNode().data, response: 'Prior answer', responses: ['Prior answer'], responseIndex: 0,
    tagIds: ['tag-1'], customTypeId: 'type-1', attachments: [{ id: 'att-1', content: 'Original attachment' }],
  } };
  useStore.setState({ nodes: useStore.getState().nodes.map((n) => n.id === manualId ? answered : n) });
  useStore.getState().setNodeEditMode(manualId, 'manual');
  await useStore.getState().editQuestion(manualId, 'Revised manually');
  for (const key of ['response', 'responses', 'attachments', 'tagIds', 'customTypeId']) {
    assert.deepEqual(currentNode().data[key], answered.data[key], `mode switch preserves ${key}`);
  }
  assert.equal(currentNode().data.questions[0], 'Saved without AI', 'prior answer keeps its original question');

  await useStore.getState().addQuestion('A structured subject', { editMode: 'manual-detail', initialResponse: 'Initial details' });
  const structuredId = useStore.getState().selectedNodeId;
  const structured = () => useStore.getState().nodes.find((n) => n.id === structuredId);
  assert.equal(structured().data.response, 'Initial details');
  assert.deepEqual(structured().data.responses, ['Initial details']);
  assert.equal(structured().data.responseIndex, 0);
  await useStore.getState().editQuestion(structuredId, 'An edited subject');
  await useStore.getState().rerunNode(structuredId, { auto: true });
  assert.equal(structured().data.isLoading, false);
  assert.equal(structured().data.response, 'Initial details', 'structured edits and automatic replay never generate');
  useStore.getState().setNodeEditMode(structuredId, 'manual');
  assert.equal(structured().data.response, 'Initial details', 'compact presentation preserves the body');
  useStore.getState().setNodeEditMode(structuredId, 'manual-detail');
  useStore.getState().editResponse(structuredId, 'Revised details');
  assert.deepEqual(structured().data.responses, ['Revised details']);
  assert.equal(structured().data.questions[0], 'An edited subject', 'manual body edits keep the active subject/body pair together');
  await flushPendingWrites();
  await useStore.persist.rehydrate();
  assert.equal(structured().data.editMode, 'manual-detail');
  assert.equal(structured().data.response, 'Revised details');

  await useStore.getState().addQuestion('Empty body', { editMode: 'manual-detail' });
  const blankId = useStore.getState().selectedNodeId;
  useStore.getState().editResponse(blankId, 'First written body');
  const written = useStore.getState().nodes.find((n) => n.id === blankId);
  assert.equal(written.data.responseIndex, 0);
  assert.deepEqual(written.data.responses, ['First written body']);
  assert.deepEqual(written.data.questions, ['Empty body']);
  useStore.getState().undo();
  assert.equal(useStore.getState().nodes.find((n) => n.id === blankId).data.response, '');
  useStore.getState().redo();
  assert.equal(useStore.getState().nodes.find((n) => n.id === blankId).data.response, 'First written body');

  const noteId = useStore.getState().nodes.find((n) => n.data.stepKind === 'note').id;
  const noteBefore = useStore.getState().nodes.find((n) => n.id === noteId);
  useStore.getState().setNodeEditMode(noteId, 'ai');
  const converted = useStore.getState().nodes.find((n) => n.id === noteId);
  assert.equal(converted.data.stepKind, undefined);
  assert.equal(converted.data.editMode, 'ai');
  assert.equal(converted.data.question, noteBefore.data.question);
  useStore.getState().undo();
  assert.equal(useStore.getState().nodes.find((n) => n.id === noteId).data.stepKind, 'note');

  console.log('Transaction durability boundary tests passed');
} finally {
  await vite.close();
}
