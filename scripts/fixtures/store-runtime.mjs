import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

globalThis.__THOUGHTDAG_TEST_IDB__ = new Map();
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.location = { hostname: 'localhost', protocol: 'http:', hash: '', href: 'http://localhost:5173/', origin: 'http://localhost:5173' };
globalThis.window = { location, addEventListener: () => {}, setTimeout };
globalThis.document = { visibilityState: 'visible', addEventListener: () => {} };

export const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
  resolve: { alias: { 'idb-keyval': fileURLToPath(new URL('./idb-keyval-memory.mjs', import.meta.url)) } },
});
export const load = (path) => vite.ssrLoadModule(path);
export const { useStore, flushPendingTransaction } = await load('/src/store/index.ts');
export const { snapshotOf } = await load('/src/lib/transactions.ts');
export const { useProjects, projectStorageKey } = await load('/src/store/projects.ts');
export const { useUiStore } = await load('/src/lib/ui-store.ts');

export function node(id, data = {}) {
  return { id, type: 'thought', position: { x: 0, y: 0 }, data: {
    question: id, response: 'answer', responses: ['answer'], responseIndex: 0,
    isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
    tokenCount: 0, highlights: [], highlightMode: 'off', attachments: [],
    excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit',
    isRoot: false, isBranch: false, ...data,
  } };
}

export function reset(nodes = [], edges = []) {
  const graph = { nodes, edges, organizationRelations: [], taxonomy: { tags: [], nodeTypes: [] } };
  useStore.setState({ ...graph, history: [snapshotOf(graph)], historyIndex: 0, events: [],
    transactions: [], undoableTransactionIds: [], redoableTransactionIds: [], revision: 0,
    selectedNodeId: null, selectedNodeIds: [], staleIds: [],
  });
  useUiStore.setState({ knowledgeQuery: {}, activeNodeId: null, localDepth: 0, confirmRequest: null });
}

export async function runTests(tests) {
  let failed = 0;
  for (const [name, run] of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}`, error); }
  }
  await vite.close();
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
}
