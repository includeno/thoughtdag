#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

globalThis.__THOUGHTDAG_TEST_IDB__ = new Map([
  ['sentinel', 'unchanged'],
]);
const local = new Map();
globalThis.localStorage = {
  getItem: (key) => local.get(key) ?? null,
  setItem: (key, value) => local.set(key, String(value)),
  removeItem: (key) => local.delete(key),
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

function node(id, tagIds = []) {
  return {
    id,
    type: 'thought',
    position: { x: 0, y: 0 },
    data: {
      question: id,
      response: '',
      responses: [],
      responseIndex: -1,
      tagIds,
      attachments: [],
    },
  };
}

const tag = {
  id: 'tag-1',
  name: 'Evidence',
  color: '#0F766E',
  createdAt: '2026-08-28T00:00:00.000Z',
};
const taxonomy = { tags: [tag], nodeTypes: [] };

function transaction(overrides = {}) {
  return {
    id: 'tx-1',
    kind: 'change',
    label: 'node.classify',
    at: '2026-08-28T00:00:00.000Z',
    beforeRevision: 0,
    afterRevision: 1,
    changes: {
      nodes: [{ id: 'n1', before: node('n1'), after: node('n1', ['tag-1']) }],
      edges: [],
      organizationRelations: [],
    },
    ...overrides,
  };
}

function payload() {
  return {
    schemaVersion: 2,
    name: 'Invalid import fixture',
    nodes: [node('n1', ['tag-1']), node('n2')],
    edges: [],
    organizationRelations: [],
    taxonomy,
    transactions: [transaction()],
    undoableTransactionIds: ['tx-1'],
    redoableTransactionIds: [],
    revision: 1,
  };
}

try {
  const [exportModule, projectsModule] = await Promise.all([
    vite.ssrLoadModule('/src/lib/export.ts'),
    vite.ssrLoadModule('/src/store/projects.ts'),
  ]);
  const { importProjectFromFile } = exportModule;
  const { projectStorageKey, useProjects } = projectsModule;
  useProjects.setState({
    projects: [{ id: 'existing', name: 'Existing', createdAt: 1, updatedAt: 1 }],
    activeId: 'existing',
    switching: false,
  });

  const rejectWithoutWrite = async (name, mutate) => {
    const candidate = structuredClone(payload());
    mutate(candidate);
    const beforeProjects = structuredClone(useProjects.getState());
    const beforeIdb = [...globalThis.__THOUGHTDAG_TEST_IDB__.entries()];
    const ok = await importProjectFromFile({ name: `${name}.thoughtdag.json` }, candidate);
    assert.equal(ok, false, `${name} must be rejected`);
    assert.deepEqual(useProjects.getState(), beforeProjects, `${name} must not change the project list`);
    assert.deepEqual(
      [...globalThis.__THOUGHTDAG_TEST_IDB__.entries()],
      beforeIdb,
      `${name} must not write project storage`,
    );
  };

  await rejectWithoutWrite('empty entity change', (input) => {
    input.transactions[0].changes.nodes = [{ id: 'n1' }];
  });
  await rejectWithoutWrite('mismatched entity id', (input) => {
    input.transactions[0].changes.nodes[0].before.id = 'n2';
  });
  await rejectWithoutWrite('invalid taxonomy snapshot', (input) => {
    input.transactions[0].changes.taxonomy = { before: taxonomy, after: { tags: [] } };
  });
  await rejectWithoutWrite('duplicate transaction id', (input) => {
    input.transactions.push(transaction({ beforeRevision: 1, afterRevision: 2 }));
    input.revision = 2;
  });
  await rejectWithoutWrite('invalid transaction metadata', (input) => {
    input.transactions[0].label = '   ';
  });
  await rejectWithoutWrite('invalid transaction timestamp', (input) => {
    input.transactions[0].at = '';
  });
  await rejectWithoutWrite('invalid transaction kind', (input) => {
    input.transactions[0].kind = 'snapshot';
  });
  await rejectWithoutWrite('invalid transaction revision', (input) => {
    input.transactions[0].afterRevision = 3;
    input.revision = 3;
  });
  await rejectWithoutWrite('overlapping transaction revisions', (input) => {
    input.transactions.push(transaction({
      id: 'tx-2',
      beforeRevision: 0,
      afterRevision: 1,
      changes: { nodes: [], edges: [], organizationRelations: [] },
    }));
  });
  await rejectWithoutWrite('transaction revision gap', (input) => {
    input.transactions.push(transaction({
      id: 'tx-2',
      beforeRevision: 2,
      afterRevision: 3,
      changes: { nodes: [], edges: [], organizationRelations: [] },
    }));
    input.revision = 3;
  });
  await rejectWithoutWrite('unknown compensation target', (input) => {
    input.transactions.push(transaction({
      id: 'tx-undo',
      kind: 'undo',
      label: 'history.undo',
      targetId: 'missing',
      beforeRevision: 1,
      afterRevision: 2,
      changes: { nodes: [], edges: [], organizationRelations: [] },
    }));
    input.revision = 2;
  });
  await rejectWithoutWrite('unknown undo stack entry', (input) => {
    input.undoableTransactionIds = ['missing'];
  });
  await rejectWithoutWrite('duplicate undo stack entry', (input) => {
    input.undoableTransactionIds = ['tx-1', 'tx-1'];
  });
  await rejectWithoutWrite('overlapping stacks', (input) => {
    input.redoableTransactionIds = ['tx-1'];
  });
  await rejectWithoutWrite('revision behind ledger', (input) => {
    input.revision = 0;
  });
  await rejectWithoutWrite('revision ahead of ledger', (input) => {
    input.revision = 2;
  });
  await rejectWithoutWrite('malformed event', (input) => {
    input.events = [{ t: '2026-08-28T00:00:00.000Z', op: 'ask', d: { nested: {} } }];
  });
  await rejectWithoutWrite('historical relation missing endpoint', (input) => {
    input.transactions[0].changes = {
      nodes: [],
      edges: [],
      organizationRelations: [{
        id: 'org-1',
        after: {
          id: 'org-1',
          sourceId: 'n1',
          targetId: 'missing',
          kind: 'parent',
          createdAt: '2026-08-28T00:00:00.000Z',
        },
      }],
    };
  });
  await rejectWithoutWrite('relation survives endpoint deletion', (input) => {
    input.transactions[0].changes = {
      nodes: [{ id: 'n2', before: node('n2') }],
      edges: [],
      organizationRelations: [{
        id: 'org-1',
        after: {
          id: 'org-1',
          sourceId: 'n1',
          targetId: 'n2',
          kind: 'parent',
          createdAt: '2026-08-28T00:00:00.000Z',
        },
      }],
    };
  });
  await rejectWithoutWrite('historical edge missing endpoint', (input) => {
    input.transactions[0].changes = {
      nodes: [],
      edges: [{ id: 'edge-1', after: { id: 'edge-1', source: 'n1', target: 'missing' } }],
      organizationRelations: [],
    };
  });
  await rejectWithoutWrite('historical classification missing definition', (input) => {
    input.transactions[0].changes.nodes[0].after.data.tagIds = ['missing-tag'];
  });
  await rejectWithoutWrite('classification outlives taxonomy definition', (input) => {
    input.transactions[0].changes.taxonomy = {
      before: taxonomy,
      after: { tags: [], nodeTypes: [] },
    };
  });
  await rejectWithoutWrite('relation endpoint exists only in a future revision', (input) => {
    const future = node('future');
    const relation = {
      id: 'org-future',
      sourceId: 'n1',
      targetId: 'future',
      kind: 'parent',
      createdAt: '2026-08-28T00:00:00.000Z',
    };
    input.nodes.push(future);
    input.organizationRelations = [relation];
    input.transactions = [
      transaction({
        changes: {
          nodes: [],
          edges: [],
          organizationRelations: [{ id: relation.id, after: relation }],
        },
      }),
      transaction({
        id: 'tx-2',
        label: 'node.create',
        beforeRevision: 1,
        afterRevision: 2,
        changes: {
          nodes: [{ id: future.id, after: future }],
          edges: [],
          organizationRelations: [],
        },
      }),
    ];
    input.undoableTransactionIds = ['tx-1', 'tx-2'];
    input.revision = 2;
  });
  await rejectWithoutWrite('classification exists only before a future taxonomy revision', (input) => {
    const futureTag = { ...tag, id: 'tag-future', name: 'Future' };
    input.nodes[0] = node('n1', ['tag-1', futureTag.id]);
    input.taxonomy = { tags: [tag, futureTag], nodeTypes: [] };
    input.transactions = [
      transaction({
        changes: {
          nodes: [{
            id: 'n1',
            before: node('n1', ['tag-1']),
            after: node('n1', ['tag-1', futureTag.id]),
          }],
          edges: [],
          organizationRelations: [],
        },
      }),
      transaction({
        id: 'tx-2',
        label: 'taxonomy.create',
        beforeRevision: 1,
        afterRevision: 2,
        changes: {
          nodes: [],
          edges: [],
          organizationRelations: [],
          taxonomy: {
            before: taxonomy,
            after: { tags: [tag, futureTag], nodeTypes: [] },
          },
        },
      }),
    ];
    input.undoableTransactionIds = ['tx-1', 'tx-2'];
    input.revision = 2;
  });
  await rejectWithoutWrite('readonly v2 dangling edge', (input) => {
    input.sharedReadonly = true;
    input.edges = [{ id: 'dangling', source: 'n1', target: 'missing' }];
  });
  await rejectWithoutWrite('legacy duplicate node id', (input) => {
    input.schemaVersion = 1;
    input.nodes.push(node('n1', ['tag-1']));
  });

  const legacyEvent = { t: 'legacy-time', op: 'legacy-operation', d: { value: 'kept' } };
  const legacy = {
    schemaVersion: 1,
    name: 'Legacy dangling fixture',
    nodes: [node('legacy')],
    edges: [{ id: 'legacy-edge', source: 'legacy', target: 'missing', data: { legacy: true } }],
    events: [legacyEvent],
  };
  const legacyOk = await importProjectFromFile({ name: 'legacy.thoughtdag.json' }, legacy);
  assert.equal(legacyOk, true, 'v1 dangling edges remain importable for topology diagnostics');
  const legacyProjectId = useProjects.getState().activeId;
  const storedLegacy = JSON.parse(globalThis.__THOUGHTDAG_TEST_IDB__.get(projectStorageKey(legacyProjectId)));
  assert.deepEqual(storedLegacy.state.edges, legacy.edges, 'v1 dangling edge is preserved verbatim');
  assert.deepEqual(storedLegacy.state.events, legacy.events, 'v1 events are preserved verbatim');
  assert.deepEqual(storedLegacy.state.organizationRelations, []);
  assert.deepEqual(storedLegacy.state.taxonomy, { tags: [], nodeTypes: [] });
  assert.deepEqual(storedLegacy.state.transactions, []);
  assert.equal(storedLegacy.state.revision, 0);

  console.log('Web v2 import validation tests passed');
} finally {
  await vite.close();
}
