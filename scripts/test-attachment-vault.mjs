#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

globalThis.__THOUGHTDAG_TEST_IDB__ = new Map();
const localValues = new Map();
globalThis.localStorage = {
  getItem: (key) => localValues.get(key) ?? null,
  setItem: (key, value) => localValues.set(key, String(value)),
  removeItem: (key) => localValues.delete(key),
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

function node(id, attachments) {
  return {
    id,
    type: 'thought',
    position: { x: 0, y: 0 },
    data: {
      question: id,
      response: '',
      responses: [],
      responseIndex: -1,
      isCollapsed: false,
      isEditing: false,
      isEditingResponse: false,
      isLoading: false,
      stepKind: 'file',
      tokenCount: 0,
      highlights: [],
      highlightMode: 'tag',
      attachments,
      excludedAttachmentIds: [],
      includedAttachmentIds: [],
      roleMode: 'inherit',
      isRoot: false,
      isBranch: false,
    },
  };
}

function deletionTransaction(deletedNode) {
  return {
    id: 'tx-delete-history-pdf',
    at: '2026-08-27T00:00:00.000Z',
    beforeRevision: 0,
    afterRevision: 1,
    kind: 'change',
    label: 'node.delete',
    changes: {
      nodes: [{ id: deletedNode.id, before: deletedNode, beforeIndex: 0 }],
      edges: [],
      organizationRelations: [],
    },
  };
}

try {
  const [vault, transactions, attachments, storeModule, projectsModule, vaultBoot, localBackup] = await Promise.all([
    vite.ssrLoadModule('/src/lib/attachment-vault.ts'),
    vite.ssrLoadModule('/src/lib/transactions.ts'),
    vite.ssrLoadModule('/src/lib/attachments.ts'),
    vite.ssrLoadModule('/src/store/index.ts'),
    vite.ssrLoadModule('/src/store/projects.ts'),
    vite.ssrLoadModule('/src/lib/attachment-vault-boot.ts'),
    vite.ssrLoadModule('/src/lib/local-backup.ts'),
  ]);
  const {
    collectVaultReferences,
    gcVault,
    inlineVaultedContent,
    inlineVaultedTransactions,
    internAttachment,
    internNodes,
    internTransactions,
    loadAttachmentContent,
  } = vault;
  const { applyTransaction, snapshotOf } = transactions;
  const { attachmentFingerprint } = attachments;
  const { useStore } = storeModule;
  const { useProjects } = projectsModule;
  const { migrateActiveCanvasToVault } = vaultBoot;
  const { backupRelevantStateChanged, buildActiveProjectBackupPayload } = localBackup;

  const currentPayload = 'data:application/pdf;base64,Q1VSUkVOVA==';
  const historyPayload = 'data:application/pdf;base64,SElTVE9SWQ==';
  const current = node('current', [{
    id: 'current-att',
    name: 'current.pdf',
    type: 'application/pdf',
    size: currentPayload.length,
    content: currentPayload,
  }]);
  const deleted = node('deleted', [{
    id: 'history-att',
    name: 'history.pdf',
    type: 'application/pdf',
    size: historyPayload.length,
    content: historyPayload,
  }]);

  const [vaultedCurrent] = await internNodes([current]);
  const vaultedTransactions = await internTransactions([deletionTransaction(deleted)]);
  const currentAttachment = vaultedCurrent.data.attachments[0];
  const historyAttachment = vaultedTransactions[0].changes.nodes[0].before.data.attachments[0];
  assert.equal(currentAttachment.content, '');
  assert.equal(currentAttachment.contentInVault, true);
  assert.match(currentAttachment.vaultId, /^sha256-[0-9a-f]{64}$/);
  assert.equal(historyAttachment.content, '');
  assert.equal(historyAttachment.contentInVault, true);
  assert.match(historyAttachment.vaultId, /^sha256-[0-9a-f]{64}$/);
  assert.notEqual(currentAttachment.vaultId, historyAttachment.vaultId);
  assert.equal(await loadAttachmentContent(currentAttachment), currentPayload);
  assert.equal(await loadAttachmentContent(historyAttachment), historyPayload);

  const duplicatedAttachment = { ...currentAttachment, id: 'current-att-copy' };
  assert.equal(
    await loadAttachmentContent(duplicatedAttachment),
    currentPayload,
    'duplicated metadata must resolve the stable vaultId instead of its new attachment id',
  );

  globalThis.__THOUGHTDAG_TEST_IDB__.set('att-content:orphan', 'orphaned');
  const references = collectVaultReferences([vaultedCurrent], vaultedTransactions);
  assert.deepEqual([...references].sort(), [currentAttachment.vaultId, historyAttachment.vaultId].sort());
  assert.equal(await gcVault(references), 1, 'GC removes only the orphaned payload');
  assert.equal(
    globalThis.__THOUGHTDAG_TEST_IDB__.has(`att-content:${historyAttachment.vaultId}`),
    true,
    'history-only payload survives GC',
  );

  const afterDeletion = {
    nodes: [],
    edges: [],
    organizationRelations: [],
    taxonomy: emptyTaxonomy,
  };
  const restored = applyTransaction(afterDeletion, vaultedTransactions[0], 'backward');
  assert.equal(restored.nodes[0].id, 'deleted');
  assert.equal(await loadAttachmentContent(restored.nodes[0].data.attachments[0]), historyPayload, 'Undo after a persisted deletion restores bytes');

  const [inlinedCurrent] = await inlineVaultedContent([vaultedCurrent]);
  const inlinedTransactions = await inlineVaultedTransactions(vaultedTransactions);
  assert.equal(inlinedCurrent.data.attachments[0].content, currentPayload);
  assert.equal(inlinedCurrent.data.attachments[0].contentInVault, undefined);
  assert.equal(inlinedTransactions[0].changes.nodes[0].before.data.attachments[0].content, historyPayload);
  assert.equal(inlinedTransactions[0].changes.nodes[0].before.data.attachments[0].contentInVault, undefined);

  globalThis.__THOUGHTDAG_TEST_IDB__.clear();
  const [roundtrippedCurrent] = await internNodes([structuredClone(inlinedCurrent)]);
  const roundtrippedTransactions = await internTransactions(structuredClone(inlinedTransactions));
  assert.equal(await loadAttachmentContent(roundtrippedCurrent.data.attachments[0]), currentPayload);
  assert.equal(
    await loadAttachmentContent(roundtrippedTransactions[0].changes.nodes[0].before.data.attachments[0]),
    historyPayload,
    'a self-contained export restores transaction-only PDF payloads on import',
  );

  // Vault dedup uses content identity, never the empty-content
  // name+size fallback that would conflate different documents.
  const sameNameA = await internAttachment({
    id: 'same-name-a',
    name: 'same.pdf',
    type: 'application/pdf',
    size: 4,
    content: 'QUFBQQ==',
  });
  const sameNameB = await internAttachment({
    id: 'same-name-b',
    name: 'same.pdf',
    type: 'application/pdf',
    size: 4,
    content: 'QkJCQg==',
  });
  const trueDuplicate = await internAttachment({
    id: 'same-name-a-again',
    name: 'same.pdf',
    type: 'application/pdf',
    size: 4,
    content: 'QUFBQQ==',
  });
  assert.notEqual(sameNameA.vaultId, sameNameB.vaultId, 'same metadata with different bytes keeps two payloads');
  assert.notEqual(attachmentFingerprint(sameNameA), attachmentFingerprint(sameNameB));
  assert.equal(sameNameA.vaultId, trueDuplicate.vaultId, 'the same bytes reuse one stable payload identity');
  assert.equal(attachmentFingerprint(sameNameA), attachmentFingerprint(trueDuplicate));

  const forgedIdentityA = await internAttachment({
    id: 'forged-a',
    vaultId: 'externally-supplied-id',
    name: 'forged.pdf',
    type: 'application/pdf',
    size: 4,
    content: 'Rk9SR0VEX0E=',
  });
  const forgedIdentityB = await internAttachment({
    id: 'forged-b',
    vaultId: 'externally-supplied-id',
    name: 'forged.pdf',
    type: 'application/pdf',
    size: 4,
    content: 'Rk9SR0VEX0I=',
  });
  assert.notEqual(forgedIdentityA.vaultId, forgedIdentityB.vaultId, 'inline bytes override an untrusted external vaultId');
  assert.notEqual(forgedIdentityA.vaultId, 'externally-supplied-id');
  assert.equal(await loadAttachmentContent(forgedIdentityA), 'Rk9SR0VEX0E=');
  assert.equal(await loadAttachmentContent(forgedIdentityB), 'Rk9SR0VEX0I=');

  const dedupNode = node('dedup', [sameNameA]);
  const dedupBaseline = snapshotOf({
    nodes: [dedupNode],
    edges: [],
    organizationRelations: [],
    taxonomy: emptyTaxonomy,
  });
  useStore.setState({
    nodes: [dedupNode],
    edges: [],
    events: [],
    organizationRelations: [],
    taxonomy: emptyTaxonomy,
    transactions: [],
    undoableTransactionIds: [],
    redoableTransactionIds: [],
    revision: 0,
    history: [dedupBaseline],
    historyIndex: 0,
  });
  useStore.getState().addAttachment('dedup', sameNameB);
  assert.equal(useStore.getState().nodes[0].data.attachments.length, 2, 'different bytes are not discarded');
  useStore.getState().addAttachment('dedup', { ...trueDuplicate, id: 'same-name-a-copy' });
  assert.equal(useStore.getState().nodes[0].data.attachments.length, 2, 'a true duplicate is still rejected');

  // Legacy inline payload migration is maintenance, not a user command.
  // Keep a redo cursor alive to prove it is not cleared or rewritten.
  globalThis.__THOUGHTDAG_TEST_IDB__.clear();
  const peer = node('peer', []);
  const relation = {
    id: 'org-current-peer',
    sourceId: 'current',
    targetId: 'peer',
    kind: 'parent',
    createdAt: '2026-08-27T00:00:00.000Z',
  };
  const taxonomy = {
    tags: [{ id: 'tag-important', name: 'Important', color: '#0f766e', createdAt: '2026-08-27T00:00:00.000Z' }],
    nodeTypes: [{ id: 'type-source', name: 'Source', color: '#b45309', createdAt: '2026-08-27T00:00:00.000Z' }],
  };
  const inlineNodes = [current, peer];
  const inlineTransaction = deletionTransaction(deleted);
  const baseline = snapshotOf({
    nodes: inlineNodes,
    edges: [],
    organizationRelations: [relation],
    taxonomy,
  });
  useStore.setState({
    nodes: inlineNodes,
    edges: [],
    events: [{ t: '2026-08-27T00:00:00.000Z', op: 'material-add', id: 'current' }],
    organizationRelations: [relation],
    taxonomy,
    transactions: [inlineTransaction],
    undoableTransactionIds: [],
    redoableTransactionIds: [inlineTransaction.id],
    revision: 1,
    history: [baseline, baseline],
    historyIndex: 0,
  });
  useProjects.setState({
    projects: [{
      id: 'vault-project',
      name: 'Vault recovery',
      createdAt: 1,
      updatedAt: 1,
      instantiatedFrom: { name: 'Fixture', at: '2026-08-27T00:00:00.000Z' },
    }],
    activeId: 'vault-project',
    switching: false,
  });

  await migrateActiveCanvasToVault();
  await new Promise((resolve) => setTimeout(resolve, 350));
  const migrated = useStore.getState();
  assert.equal(migrated.transactions.length, 1, 'migration does not append a user transaction');
  assert.equal(migrated.transactions[0].id, inlineTransaction.id);
  assert.deepEqual(migrated.undoableTransactionIds, []);
  assert.deepEqual(migrated.redoableTransactionIds, [inlineTransaction.id], 'migration preserves redo');
  assert.equal(migrated.revision, 1, 'migration does not advance revision');
  assert.equal(migrated.nodes[0].data.attachments[0].contentInVault, true);
  assert.equal(migrated.transactions[0].changes.nodes[0].before.data.attachments[0].contentInVault, true);
  assert.equal(migrated.history[migrated.historyIndex].nodes[0].data.attachments[0].contentInVault, true);

  const backup = await buildActiveProjectBackupPayload();
  assert.ok(backup);
  assert.equal(backup.schemaVersion, 2);
  assert.equal(backup.version, 2);
  assert.equal(backup.name, 'Vault recovery');
  assert.deepEqual(backup.events, migrated.events);
  assert.deepEqual(backup.organizationRelations, [relation]);
  assert.deepEqual(backup.taxonomy, taxonomy);
  assert.deepEqual(backup.undoableTransactionIds, []);
  assert.deepEqual(backup.redoableTransactionIds, [inlineTransaction.id]);
  assert.equal(backup.revision, 1);
  assert.equal(backup.nodes[0].data.attachments[0].content, currentPayload);
  assert.equal(backup.nodes[0].data.attachments[0].contentInVault, undefined);
  assert.equal(backup.transactions[0].changes.nodes[0].before.data.attachments[0].content, historyPayload);
  assert.equal(backup.transactions[0].changes.nodes[0].before.data.attachments[0].contentInVault, undefined);

  const relevantKeys = [
    'nodes',
    'edges',
    'events',
    'organizationRelations',
    'taxonomy',
    'transactions',
    'undoableTransactionIds',
    'redoableTransactionIds',
    'revision',
  ];
  for (const key of relevantKeys) {
    const changed = { ...migrated, [key]: key === 'revision' ? migrated.revision + 1 : [] };
    assert.equal(backupRelevantStateChanged(changed, migrated), true, `backup watches ${key}`);
  }
  assert.equal(backupRelevantStateChanged(migrated, migrated), false);

  console.log('Attachment vault recovery tests passed');
} finally {
  await vite.close();
}
