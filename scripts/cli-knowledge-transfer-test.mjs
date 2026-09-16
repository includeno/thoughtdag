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

function node(id, kind = 'note') {
  return {
    id,
    type: 'thought',
    position: { x: 0, y: 0 },
    dragHandle: '.drag-handle',
    data: {
      question: id,
      response: '',
      responses: [],
      responseIndex: -1,
      isCollapsed: false,
      isEditing: false,
      isEditingResponse: false,
      isLoading: false,
      stepKind: kind,
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

try {
  const [executorModule, storeModule, projectsModule, transactionsModule] = await Promise.all([
    vite.ssrLoadModule('/src/lib/cli-executor.ts'),
    vite.ssrLoadModule('/src/store/index.ts'),
    vite.ssrLoadModule('/src/store/projects.ts'),
    vite.ssrLoadModule('/src/lib/transactions.ts'),
  ]);
  const { executeCliCommand, parseCliProjectImport } = executorModule;
  const { useStore } = storeModule;
  const { projectStorageKey, useProjects } = projectsModule;
  const { snapshotOf } = transactionsModule;

  const sourceNodes = [node('a'), node('b'), node('c'), node('frame', 'frame')];
  const emptyTaxonomy = { tags: [], nodeTypes: [] };
  const initialSnapshot = snapshotOf({
    nodes: sourceNodes,
    edges: [],
    organizationRelations: [],
    taxonomy: emptyTaxonomy,
  });
  useStore.setState({
    nodes: sourceNodes,
    edges: [],
    events: [],
    organizationRelations: [],
    taxonomy: emptyTaxonomy,
    transactions: [],
    undoableTransactionIds: [],
    redoableTransactionIds: [],
    revision: 0,
    history: [initialSnapshot],
    historyIndex: 0,
  });
  useProjects.setState({
    projects: [{
      id: 'source-project',
      name: 'Knowledge source',
      createdAt: 1,
      updatedAt: 1,
      instantiatedFrom: { name: 'Fixture', at: '2026-08-27T00:00:00.000Z' },
    }],
    activeId: 'source-project',
    switching: false,
  });

  const revision = () => useStore.getState().revision;
  const unchangedAfterFailure = async (command, args, message) => {
    const before = JSON.stringify({
      nodes: useStore.getState().nodes,
      organizationRelations: useStore.getState().organizationRelations,
      taxonomy: useStore.getState().taxonomy,
      transactions: useStore.getState().transactions,
      revision: revision(),
    });
    await assert.rejects(() => executeCliCommand(command, args), message);
    const after = JSON.stringify({
      nodes: useStore.getState().nodes,
      organizationRelations: useStore.getState().organizationRelations,
      taxonomy: useStore.getState().taxonomy,
      transactions: useStore.getState().transactions,
      revision: revision(),
    });
    assert.equal(after, before, `${command} must fail atomically`);
  };

  const tag = await executeCliCommand('tag.create', { name: '  Key   evidence ', color: '#0F766E' });
  assert.equal(tag.name, 'Key evidence');
  assert.equal(revision(), 1, 'tag.create is one transaction');
  await unchangedAfterFailure('tag.create', { name: 'key evidence' }, /already exists/);

  const type = await executeCliCommand('type.create', { name: 'Decision' });
  assert.equal(revision(), 2, 'type.create is one transaction');
  await executeCliCommand('node.classify', {
    nodeIds: ['a', 'b', 'a'],
    tagIds: [tag.id, tag.id],
    customTypeId: type.id,
  });
  assert.equal(revision(), 3, 'batched node.classify is one transaction');
  for (const id of ['a', 'b']) {
    const classified = useStore.getState().nodes.find((item) => item.id === id);
    assert.deepEqual(classified.data.tagIds, [tag.id]);
    assert.equal(classified.data.customTypeId, type.id);
    assert.equal(classified.data.stepKind, 'note', 'classification does not overwrite the system node kind');
  }
  await executeCliCommand('node.classify', { nodeIds: ['a', 'b'], tagIds: [] });
  assert.equal(revision(), 4, 'replace-to-empty is one transaction');
  assert.deepEqual(useStore.getState().nodes.find((item) => item.id === 'a').data.tagIds, []);
  assert.equal(useStore.getState().nodes.find((item) => item.id === 'a').data.customTypeId, type.id, 'omitted type is unchanged');
  await executeCliCommand('node.classify', {
    nodeIds: ['a'], tagIds: [tag.id], customTypeId: null,
  });
  assert.equal(revision(), 5, 'explicit null clears the type in the same classification transaction');
  assert.deepEqual(useStore.getState().nodes.find((item) => item.id === 'a').data.tagIds, [tag.id]);
  assert.equal(useStore.getState().nodes.find((item) => item.id === 'a').data.customTypeId, undefined);
  await unchangedAfterFailure('node.classify', {
    nodeIds: ['a', 'missing'],
    tagIds: [tag.id],
  }, /Node not found/);
  await unchangedAfterFailure('node.classify', {
    nodeIds: ['a'],
    tagIds: ['missing-tag'],
  }, /Tag not found/);

  const parentAB = await executeCliCommand('organization.connect', {
    sourceId: 'a', targetId: 'b', kind: 'parent',
  });
  await unchangedAfterFailure('organization.connect', {
    sourceId: 'a', targetId: 'b', kind: 'parent',
  }, /duplicate/);
  await unchangedAfterFailure('organization.connect', {
    sourceId: 'missing', targetId: 'b', kind: 'parent',
  }, /Node not found/);
  const parentBC = await executeCliCommand('organization.connect', {
    sourceId: 'b', targetId: 'c', kind: 'parent',
  });
  assert.equal(revision(), 7, 'each organization.connect is one transaction');
  await unchangedAfterFailure('organization.connect', {
    sourceId: 'c', targetId: 'a', kind: 'parent',
  }, /parent-cycle/);
  await unchangedAfterFailure('organization.connect', {
    sourceId: 'frame', targetId: 'a', kind: 'jump',
  }, /Frame/);
  const jump = await executeCliCommand('organization.connect', {
    sourceId: 'c', targetId: 'a', kind: 'jump',
  });
  assert.equal(revision(), 8, 'jump creation is one transaction');
  const beforeInvalidBatch = JSON.stringify({
    nodes: useStore.getState().nodes,
    organizationRelations: useStore.getState().organizationRelations,
    revision: revision(),
  });
  assert.equal(
    useStore.getState().deleteOrganizationRelations([parentAB.id, 'missing-relation']),
    false,
    'store relation deletion validates the full batch before writing',
  );
  useStore.getState().setNodeTag(['a', 'missing-node'], tag.id, true);
  useStore.getState().setNodeCustomType(['b', 'missing-node'], type.id);
  assert.equal(JSON.stringify({
    nodes: useStore.getState().nodes,
    organizationRelations: useStore.getState().organizationRelations,
    revision: revision(),
  }), beforeInvalidBatch, 'store batch actions reject unknown targets without partial writes');
  await executeCliCommand('organization.delete', { relationIds: [parentAB.id, jump.id] });
  assert.equal(revision(), 9, 'batched organization.delete is one transaction');
  assert.deepEqual(useStore.getState().organizationRelations.map((item) => item.id), [parentBC.id]);
  await unchangedAfterFailure('organization.delete', {
    relationIds: [parentBC.id, 'missing-relation'],
  }, /not found/);

  await executeCliCommand('tag.rename', { tagId: tag.id, name: 'Verified evidence' });
  await executeCliCommand('type.rename', { typeId: type.id, name: 'Final decision' });
  assert.equal(revision(), 11, 'renames each create one transaction and preserve IDs');
  assert.equal(useStore.getState().taxonomy.tags[0].id, tag.id);
  assert.equal(useStore.getState().taxonomy.nodeTypes[0].id, type.id);
  await executeCliCommand('node.classify', {
    nodeIds: ['a', 'b'], tagIds: [tag.id], customTypeId: type.id,
  });
  await executeCliCommand('tag.delete', { tagId: tag.id });
  assert.equal(revision(), 13, 'tag.delete and prior classify each create one transaction');
  assert.ok(useStore.getState().nodes.every((item) => !item.data.tagIds?.includes(tag.id)), 'tag.delete cleans every node reference atomically');
  await executeCliCommand('type.delete', { typeId: type.id });
  assert.equal(revision(), 14, 'type.delete is one transaction');
  assert.ok(useStore.getState().nodes.every((item) => item.data.customTypeId !== type.id), 'type.delete cleans every node reference atomically');

  const roundtripTag = await executeCliCommand('tag.create', { name: 'Roundtrip tag' });
  const roundtripType = await executeCliCommand('type.create', { name: 'Roundtrip type' });
  await executeCliCommand('node.classify', {
    nodeIds: ['b'], tagIds: [roundtripTag.id], customTypeId: roundtripType.id,
  });
  const roundtripRelation = await executeCliCommand('organization.connect', {
    sourceId: 'a', targetId: 'c', kind: 'jump',
  });
  useStore.getState().logEvent('connect', roundtripRelation.id, { cli: true });

  const full = await executeCliCommand('canvas.export', {});
  assert.equal(full.schemaVersion, 2);
  assert.equal(full.version, 2);
  assert.deepEqual(full.organizationRelations, useStore.getState().organizationRelations);
  assert.deepEqual(full.taxonomy, useStore.getState().taxonomy);
  assert.deepEqual(full.transactions, useStore.getState().transactions);
  assert.deepEqual(full.undoableTransactionIds, useStore.getState().undoableTransactionIds);
  assert.deepEqual(full.redoableTransactionIds, useStore.getState().redoableTransactionIds);
  assert.equal(full.revision, useStore.getState().revision);
  assert.deepEqual(full.instantiatedFrom, { name: 'Fixture', at: '2026-08-27T00:00:00.000Z' });

  const wireFull = JSON.parse(JSON.stringify(full));
  const imported = await executeCliCommand('project.import', { ...wireFull, name: 'Imported full' });
  const rawFull = JSON.parse(globalThis.__THOUGHTDAG_TEST_IDB__.get(projectStorageKey(imported.id)));
  assert.equal(rawFull.version, 2, 'project.import writes the v2 persistence envelope');
  assert.deepEqual(rawFull.state.organizationRelations, wireFull.organizationRelations);
  assert.deepEqual(rawFull.state.taxonomy, wireFull.taxonomy);
  assert.deepEqual(rawFull.state.events, wireFull.events);
  assert.deepEqual(rawFull.state.transactions, wireFull.transactions);
  assert.deepEqual(rawFull.state.undoableTransactionIds, wireFull.undoableTransactionIds);
  assert.deepEqual(rawFull.state.redoableTransactionIds, wireFull.redoableTransactionIds);
  assert.equal(rawFull.state.revision, wireFull.revision);
  assert.deepEqual(useStore.getState().organizationRelations, wireFull.organizationRelations, 'import rehydrates organization relations');
  assert.deepEqual(useStore.getState().taxonomy, wireFull.taxonomy, 'import rehydrates taxonomy');
  assert.deepEqual(useStore.getState().transactions, wireFull.transactions, 'import rehydrates transactions');
  assert.equal(useStore.getState().revision, wireFull.revision, 'import rehydrates revision');

  const readonly = await executeCliCommand('canvas.get', { sharedReadonly: true });
  assert.equal(readonly.sharedReadonly, true);
  assert.ok('organizationRelations' in readonly && 'taxonomy' in readonly);
  for (const forbidden of ['events', 'transactions', 'undoableTransactionIds', 'redoableTransactionIds', 'revision']) {
    assert.ok(!(forbidden in readonly), `read-only transfer omits ${forbidden}`);
  }
  const readonlyWithInjectedHistory = {
    ...readonly,
    events: full.events,
    transactions: full.transactions,
    undoableTransactionIds: full.undoableTransactionIds,
    redoableTransactionIds: full.redoableTransactionIds,
    revision: full.revision,
    name: 'Imported read-only',
  };
  const importedReadonly = await executeCliCommand('project.import', readonlyWithInjectedHistory);
  const rawReadonly = JSON.parse(globalThis.__THOUGHTDAG_TEST_IDB__.get(projectStorageKey(importedReadonly.id)));
  for (const forbidden of ['events', 'transactions', 'undoableTransactionIds', 'redoableTransactionIds', 'revision']) {
    assert.ok(!(forbidden in rawReadonly.state), `read-only import strips injected ${forbidden}`);
  }
  assert.deepEqual(rawReadonly.state.organizationRelations, readonly.organizationRelations);
  assert.deepEqual(rawReadonly.state.taxonomy, readonly.taxonomy);

  const malformed = structuredClone(wireFull);
  malformed.organizationRelations = [...malformed.organizationRelations, {
    id: 'cycle-relation',
    sourceId: 'c',
    targetId: 'b',
    kind: 'parent',
    createdAt: '2026-08-27T00:00:00.000Z',
  }];
  assert.throws(() => parseCliProjectImport(malformed), /parent cycle/);
  const invalidStack = structuredClone(wireFull);
  invalidStack.undoableTransactionIds = ['missing-transaction'];
  assert.throws(() => parseCliProjectImport(invalidStack), /unknown change transaction/);
  const invalidEndpoint = structuredClone(wireFull);
  invalidEndpoint.edges = [{ id: 'missing-edge', source: 'a', target: 'missing', data: {} }];
  assert.throws(() => parseCliProjectImport(invalidEndpoint), /missing node/);
  const structuralCycle = structuredClone(wireFull);
  structuralCycle.edges = [
    { id: 'edge-a-b', source: 'a', target: 'b', data: {} },
    { id: 'edge-b-a', source: 'b', target: 'a', data: {} },
  ];
  assert.throws(() => parseCliProjectImport(structuralCycle), /structural edges contain a cycle/);
  const legacyEvent = { t: 'legacy-time', op: 'legacy-operation', d: { value: 'kept' } };
  const legacy = parseCliProjectImport({
    schemaVersion: 1,
    nodes: [node('legacy')],
    edges: [{ id: 'legacy-dangling', source: 'legacy', target: 'missing', data: { legacy: true } }],
    events: [legacyEvent],
  });
  assert.deepEqual(legacy.taxonomy, { tags: [], nodeTypes: [] }, 'v1 graph-only imports remain compatible');
  assert.deepEqual(legacy.organizationRelations, []);
  assert.equal(legacy.edges[0].target, 'missing', 'v1 dangling edges are preserved for topology diagnostics');
  assert.deepEqual(legacy.events, [legacyEvent], 'v1 events are preserved verbatim');
  assert.deepEqual(legacy.transactions, []);
  assert.equal(legacy.revision, 0);

  const quick = await executeCliCommand('node.create', { question: 'Mode test' });
  assert.equal(quick.node.data.editMode, 'manual', 'CLI creation defaults to manual');
  for (const editMode of ['manual-detail', 'ai', 'manual', 'ai', 'manual-detail', 'manual']) {
    const before = revision();
    const updated = await executeCliCommand('node.update', {
      nodeId: quick.id, patch: { editMode, question: 'Preserved subject', response: 'Preserved body' },
    });
    assert.equal(updated.node.data.editMode, editMode);
    assert.equal(updated.node.data.response, 'Preserved body');
    assert.equal(revision(), before + 1, 'mode and content change in one transaction');
    await executeCliCommand('history.undo', {});
    await executeCliCommand('history.redo', {});
    assert.equal(useStore.getState().nodes.find((n) => n.id === quick.id).data.editMode, editMode);
  }
  const listed = await executeCliCommand('node.list', {});
  assert.equal(listed.find((n) => n.id === quick.id).editMode, 'manual');
  for (const editMode of ['typo', null, ['ai']]) {
    await unchangedAfterFailure('node.update', { nodeId: quick.id, patch: { editMode, question: 'Do not write' } }, /editMode/);
    await unchangedAfterFailure('node.create', { question: 'Do not create', editMode }, /editMode/);
  }
  for (const kind of ['file', 'link', 'frame', 'human', 'prompt']) {
    await unchangedAfterFailure('node.create', { kind, url: 'https://example.com', editMode: 'ai' }, /does not support/);
  }
  await unchangedAfterFailure('node.regenerate', { nodeId: quick.id }, /Switch editMode/);
  await unchangedAfterFailure('question.ask', { question: 'Do not generate', editMode: 'manual-detail' }, /requires ai/);
  const noteToAI = await executeCliCommand('node.create', { kind: 'note', question: 'Legacy note', response: 'Body', editMode: 'ai' });
  assert.equal(noteToAI.node.data.stepKind, undefined);
  assert.equal(noteToAI.node.data.response, 'Body');
  await executeCliCommand('node.update', { nodeId: noteToAI.id, patch: { editMode: 'manual-detail' } });
  useStore.setState({ nodes: useStore.getState().nodes.map((n) => n.id === noteToAI.id ? { ...n, data: { ...n.data, isLoading: true } } : n) });
  await unchangedAfterFailure('node.update', { nodeId: noteToAI.id, patch: { editMode: 'manual' } }, /Stop generation/);
  useStore.setState({ nodes: useStore.getState().nodes.map((n) => n.id === noteToAI.id ? { ...n, data: { ...n.data, isLoading: false } } : n) });
  const modeExport = JSON.parse(JSON.stringify(await executeCliCommand('canvas.export', {})));
  const modeImport = parseCliProjectImport(modeExport);
  assert.equal(modeImport.nodes.find((n) => n.id === quick.id).data.editMode, 'manual');
  assert.equal(modeImport.nodes.find((n) => n.id === noteToAI.id).data.editMode, 'manual-detail');
  const { buildViewerLink, decodeViewerHash } = await vite.ssrLoadModule('/src/lib/viewer.ts');
  const viewer = await decodeViewerHash(new URL(await buildViewerLink(modeImport.nodes, modeImport.edges)).hash);
  assert.equal(viewer.nodes.find((n) => n.id === quick.id).data.editMode, 'manual');
  assert.equal(viewer.nodes.find((n) => n.id === noteToAI.id).data.editMode, 'manual-detail');
  const invalidMode = structuredClone(modeExport);
  invalidMode.nodes[0].data.editMode = 'wrong';
  assert.throws(() => parseCliProjectImport(invalidMode), /editMode/);

  console.log('CLI knowledge, three edit modes and v2 transfer tests passed');
} finally {
  await vite.close();
}
