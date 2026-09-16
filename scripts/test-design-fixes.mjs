import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, useStore, useProjects, useUiStore, projectStorageKey, node, reset, snapshotOf, runTests } from './fixtures/store-runtime.mjs';

const projects = await load('/src/store/projects.ts');
const persistence = await load('/src/lib/persistence.ts');
const tx = await load('/src/lib/transactions.ts');
const imports = await load('/src/lib/transaction-import.ts');
const context = await load('/src/store/context-builder.ts');
const releases = await load('/src/lib/release-channel.ts');
const streaming = await load('/src/store/streaming.ts');
const { setModelsCache } = await load('/src/lib/use-models.ts');
const memory = globalThis.__THOUGHTDAG_TEST_IDB__;
const tests = [];
const test = (name, run) => tests.push([name, async () => {
  globalThis.__THOUGHTDAG_TEST_IDB_HOOK__ = undefined;
  try { await run(); } finally { globalThis.__THOUGHTDAG_TEST_IDB_HOOK__ = undefined; }
}]);
const state = () => useStore.getState();
function edit(id, patch) { useStore.setState(s => ({ nodes: s.nodes.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n) })); }
async function setupProjects(busy = false) {
  useStore.persist.setOptions({ name: projectStorageKey('a') });
  reset([node('source', busy ? { attachments: [{ id: 'pdf', name: 'paper.pdf', isExtracting: true }] } : {})]);
  useProjects.setState({ activeId: 'a', switching: false, projects: ['a', 'b'].map(id => ({ id, name: id, createdAt: 1, updatedAt: 1 })) });
  memory.set(projectStorageKey('a'), { state: { nodes: state().nodes, edges: [] }, version: 2 });
  memory.set(projectStorageKey('b'), { state: { nodes: [node('target')], edges: [] }, version: 2 });
  if (!busy) await persistence.flushPendingWrites();
}
function assertSource() {
  assert.equal(useProjects.getState().activeId, 'a');
  assert.equal(state().nodes[0].id, 'source');
  assert.equal(useStore.persist.getOptions().name, projectStorageKey('a'));
  assert.equal(useProjects.getState().switching, false);
  assert.ok(memory.has(projectStorageKey('a')));
}
test('D1.01 busy switch rejects and preserves source', async () => {
  await setupProjects(true); await assert.rejects(projects.switchProject('b')); assertSource();
});
test('D1.02 busy active deletion cannot delete its source', async () => {
  await setupProjects(true); await assert.rejects(projects.deleteProject('a')); assertSource();
  assert.equal(useProjects.getState().projects.length, 2);
});
test('D1.03 busy archive cannot archive its source', async () => {
  await setupProjects(true); await assert.rejects(projects.setProjectArchived('a', true)); assertSource();
  assert.ok(!useProjects.getState().projects[0].archived);
});
test('D1.04 failed creation rolls back metadata', async () => {
  await setupProjects(true); await assert.rejects(projects.createProject()); assertSource();
  assert.deepEqual(useProjects.getState().projects.map(p => p.id), ['a', 'b']);
});
test('D1.05 failed adoption preserves staged import and rolls back registration', async () => {
  await setupProjects(true); memory.set(projectStorageKey('import'), { state: { nodes: [], edges: [] }, version: 2 });
  await assert.rejects(projects.adoptImportedProject('import', 'Imported')); assertSource();
  assert.ok(memory.has(projectStorageKey('import')));
  assert.equal(useProjects.getState().projects.length, 2);
});
test('D1.06 missing target rejects; same target is an idempotent success', async () => {
  await setupProjects(); await assert.rejects(projects.switchProject('missing')); await projects.switchProject('a'); assertSource();
});
for (const [label, raw] of [['corrupt JSON', '{bad'], ['invalid envelope', { state: { nodes: 'bad' }, version: 2 }], ['invalid node', { state: { nodes: [null], edges: [] }, version: 2 }]]) {
  test(`D1.07 ${label} cannot replace the live graph`, async () => {
    await setupProjects(); memory.set(projectStorageKey('b'), raw);
    await assert.rejects(projects.switchProject('b')); assertSource();
  });
}
test('D1.08 read failure keeps live graph, key and metadata', async () => {
  await setupProjects(); globalThis.__THOUGHTDAG_TEST_IDB_HOOK__ = (op, key) => { if (op === 'get' && key === projectStorageKey('b')) throw new Error('read failed'); };
  await assert.rejects(projects.switchProject('b'), /read failed/); assertSource();
});
test('D1.09 failed outgoing write remains retryable', async () => {
  await setupProjects(); edit('source', { question: 'unsaved' });
  globalThis.__THOUGHTDAG_TEST_IDB_HOOK__ = (op, key) => { if (op === 'set' && key === projectStorageKey('a')) throw new Error('write failed'); };
  await assert.rejects(projects.switchProject('b'), /write failed/); assertSource();
  globalThis.__THOUGHTDAG_TEST_IDB_HOOK__ = undefined;
  await projects.switchProject('b');
  assert.equal(memory.get(projectStorageKey('a')).state.nodes[0].data.question, 'unsaved');
  assert.equal(state().nodes[0].id, 'target');
});
test('D1.10 failed metadata write cannot replace source', async () => {
  await setupProjects(); globalThis.__THOUGHTDAG_TEST_IDB_HOOK__ = (op, key) => { if (op === 'set' && key === 'thoughtdag:projects') throw new Error('meta failed'); };
  await assert.rejects(projects.switchProject('b'), /meta failed/); assertSource();
});
test('D1.11 concurrent switch rejects instead of reporting success', async () => {
  await setupProjects(); const first = projects.switchProject('b');
  await assert.rejects(projects.switchProject('a')); await first;
  assert.equal(useProjects.getState().activeId, 'b');
});
test('D1.12 deleting the last project creates an active replacement', async () => {
  await setupProjects(); useProjects.setState(s => ({ projects: s.projects.slice(0, 1) }));
  await projects.deleteProject('a');
  assert.equal(useProjects.getState().projects.length, 1);
  assert.notEqual(useProjects.getState().activeId, 'a');
  assert.equal(state().nodes.length, 0); assert.ok(!memory.has(projectStorageKey('a')));
});
test('D1.13 concurrent flush callers wait for a newer queued edit', async () => {
  await setupProjects(); edit('source', { question: 'first write' });
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let gated = false;
  globalThis.__THOUGHTDAG_TEST_IDB_HOOK__ = async (op, key) => {
    if (op === 'set' && key === projectStorageKey('a') && !gated) { gated = true; started(); await gate; }
  };
  const first = persistence.flushPendingWrites(); await waiting;
  edit('source', { question: 'newest write' }); const second = persistence.flushPendingWrites();
  release(); await Promise.all([first, second]);
  assert.equal(memory.get(projectStorageKey('a')).state.nodes[0].data.question, 'newest write');
});

for (const [label, draft] of [['stream', { isLoading: true, response: 'partial' }], ['restream', { restreaming: true, response: 'partial' }], ['extraction', { attachments: [{ id: 'pdf', isExtracting: true }] }]]) {
  test(`D2.01 explicit commit defers ${label}`, () => {
    reset([node('a'), node('b')]); edit('a', draft); edit('b', { question: 'edited' }); state().pushHistory('edit');
    assert.equal(state().transactions.length, 0); assert.equal(state().nodes[1].data.question, 'edited');
  });
}
test('D2.02 Undo and Redo do not apply over an in-flight generation', () => {
  reset([node('a')]); edit('a', { question: 'new' }); state().pushHistory(); state().undo();
  edit('a', { isLoading: true, response: 'partial' }); const revision = state().revision;
  state().redo(); state().undo(); assert.equal(state().revision, revision); assert.equal(state().nodes[0].data.response, 'partial');
});
test('D2.03 finishing concurrent streams records only complete answers', () => {
  reset([node('a'), node('b')]); edit('a', { isLoading: true, response: 'partial A' }); edit('b', { isLoading: true, response: 'partial B' });
  edit('a', { isLoading: false, response: 'final A' }); state().pushHistory(); assert.equal(state().transactions.length, 0);
  edit('b', { isLoading: false, response: 'final B' }); state().pushHistory();
  assert.equal(state().transactions.length, 1); assert.ok(!JSON.stringify(state().transactions).includes('partial'));
  state().undo(); assert.deepEqual(state().nodes.map(n => n.data.response), ['answer', 'answer']);
  state().redo(); assert.deepEqual(state().nodes.map(n => n.data.response), ['final A', 'final B']);
});
test('D2.04 pending move after Undo starts a new branch before Redo', () => {
  reset([node('a')]); edit('a', { question: 'new' }); state().pushHistory(); state().undo();
  useStore.setState(s => ({ nodes: s.nodes.map(n => ({ ...n, position: { x: 99, y: 0 } })) }));
  state().redo(); assert.equal(state().nodes[0].position.x, 99); assert.equal(state().nodes[0].data.question, 'a');
  assert.deepEqual(state().redoableTransactionIds, []); state().undo(); assert.equal(state().nodes[0].position.x, 0);
});
test('D2.05 selection changes do not invalidate Redo', () => {
  reset([node('a')]); edit('a', { question: 'new' }); state().pushHistory(); state().undo();
  useStore.setState(s => ({ nodes: s.nodes.map(n => ({ ...n, selected: true })) })); state().redo();
  assert.equal(state().nodes[0].data.question, 'new');
});
test('D2.06 completed history remains replayable after serialization', () => {
  const saved = JSON.parse(JSON.stringify(state().transactions)); imports.validateTransactionHistory(saved, snapshotOf(state()));
});
test('D2.07 reload recovers an unfinished draft as a reversible failed generation', () => {
  reset([node('a')]); edit('a', { question: 'committed' }); state().pushHistory();
  edit('a', { isLoading: true, response: 'unfinished draft' });
  const options = useStore.persist.getOptions();
  const saved = JSON.parse(JSON.stringify(options.partialize(state())));
  const recovered = options.merge(saved, state()); useStore.setState(recovered);
  assert.equal(state().nodes[0].data.response, 'unfinished draft');
  assert.equal(state().nodes[0].data.generationFailed, true); assert.equal(state().nodes[0].data.isLoading, false);
  assert.equal(state().transactions.at(-1).label, 'canvas.recover-draft');
  imports.validateTransactionHistory(state().transactions, snapshotOf(state()));
  state().undo(); assert.equal(state().nodes[0].data.response, 'answer');
  assert.equal(state().nodes[0].data.question, 'committed');
});
test('D2.08 settled reload does not manufacture a recovery command', () => {
  reset([node('a')]); edit('a', { question: 'committed' }); state().pushHistory();
  const options = useStore.persist.getOptions();
  const saved = JSON.parse(JSON.stringify(options.partialize(state())));
  assert.equal(saved.draftBaseline, undefined);
  const recovered = options.merge(saved, state()); assert.equal(recovered.transactions.length, 1);
});

const graph = nodes => ({ nodes, edges: [], organizationRelations: [], taxonomy: { tags: [], nodeTypes: [] } });
test('D3.01 forty moves and edits do not duplicate a 256 KiB image', () => {
  const image = 'X'.repeat(256 * 1024);
  reset([node('a', { attachments: [{ id: 'image', type: 'image/png', content: image, name: 'test.png' }] })]);
  for (let i = 1; i <= 40; i++) {
    useStore.setState(s => ({ nodes: s.nodes.map(n => ({ ...n, position: { x: i, y: 0 }, data: { ...n.data, question: `edit ${i}` } })) })); state().pushHistory();
  }
  const size = JSON.stringify(state().transactions).length;
  assert.ok(size < 40000, `ledger too large: ${size}`); console.log(`  256 KiB image / 40 moves+edits: ${size} ledger bytes`);
  for (let i = 0; i < 40; i++) state().undo();
  assert.equal(state().nodes[0].position.x, 0); assert.equal(state().nodes[0].data.attachments[0].content, image);
  for (let i = 0; i < 40; i++) state().redo();
  assert.equal(state().nodes[0].data.question, 'edit 40');
  imports.validateTransactionHistory(state().transactions, snapshotOf(state()));
});
test('D3.02 nested scalar and array changes survive a JSON roundtrip', () => {
  const before = graph([node('a')]); const after = graph([node('a', { response: 'new', responses: ['new', 'old'], tokenCount: 10 })]);
  const change = JSON.parse(JSON.stringify(tx.createTransaction(before, after)));
  assert.deepEqual(tx.applyTransaction(before, change, 'forward'), after);
  assert.deepEqual(tx.applyTransaction(after, change, 'backward'), before);
});
test('D3.03 optional field removal restores on Undo', () => {
  const before = graph([node('a', { model: 'test' })]); const after = graph([node('a')]);
  const change = JSON.parse(JSON.stringify(tx.createTransaction(before, after)));
  assert.deepEqual(tx.applyTransaction(before, change, 'forward'), after);
  assert.deepEqual(tx.applyTransaction(after, change, 'backward'), before);
});
test('D3.04 node insertion/deletion retains restorable attachments', () => {
  const before = graph([node('a', { attachments: [{ id: 'image', data: 'bytes' }] })]); const after = graph([]);
  const change = tx.createTransaction(before, after); assert.ok(change.changes.nodes[0].before);
  assert.deepEqual(tx.applyTransaction(after, change, 'backward'), before);
});
test('D3.05 attachment edits retain full entities for vault migration', () => {
  const before = graph([node('a')]); const after = graph([node('a', { attachments: [{ id: 'image', data: 'bytes' }] })]);
  const change = tx.createTransaction(before, after); assert.ok(change.changes.nodes[0].before); assert.ok(!change.changes.nodes[0].patches);
  assert.deepEqual(tx.applyTransaction(after, change, 'backward'), before);
});
test('D3.06 reorder patches preserve array order in both directions', () => {
  const a = node('a'), b = node('b'), c = node('c'); const before = graph([a, b, c]); const after = graph([c, a, b]);
  const change = tx.createTransaction(before, after);
  assert.deepEqual(tx.applyTransaction(before, change, 'forward').nodes.map(n => n.id), ['c', 'a', 'b']);
  assert.deepEqual(tx.applyTransaction(after, change, 'backward').nodes.map(n => n.id), ['a', 'b', 'c']);
});
const validators = { node: v => { assert.equal(typeof v.data.question, 'string'); return v; }, edge: v => v, organizationRelation: v => v, taxonomy: v => v };
const patchLedger = patches => ({ transactions: [{ id: 'tx', at: 'now', label: 'test', kind: 'change', beforeRevision: 0, afterRevision: 1,
  changes: { nodes: [{ id: 'a', patches, beforeIndex: 0, afterIndex: 0 }], edges: [], organizationRelations: [] } }] });
for (const [label, patches] of [
  ['prototype pollution', [{ path: ['__proto__', 'polluted'], after: true }]],
  ['entity identity', [{ path: ['id'], before: 'a', after: 'b' }]],
  ['overlapping paths', [{ path: ['position'], before: {}, after: {} }, { path: ['position', 'x'], before: 0, after: 1 }]],
  ['attachment bypass', [{ path: ['data', 'attachments'], before: [], after: [] }]],
]) test(`D3.07 import rejects ${label}`, () => assert.throws(() => imports.parseTransactionLedger(patchLedger(patches), validators)));
test('D3.08 imported patch must match current entity', () => {
  const ledger = imports.parseTransactionLedger(patchLedger([{ path: ['data', 'question'], before: 'old', after: 'wrong' }]), validators);
  assert.throws(() => imports.validateTransactionHistory(ledger.transactions, graph([node('a')]), validators), /continuous/);
});
test('D3.09 reverse replay validates full entity schema', () => {
  const ledger = imports.parseTransactionLedger(patchLedger([{ path: ['data', 'question'], before: 123, after: 'a' }]), validators);
  assert.throws(() => imports.validateTransactionHistory(ledger.transactions, graph([node('a')]), validators));
});

const edge = { id: 'ab', source: 'a', target: 'b', data: {} };
function upstream(extra = {}) { return [node('a', extra), node('b')]; }
test('D4.01 same-size image replacement changes fingerprint', () => {
  const img = data => [{ mimeType: 'image/png', data }];
  assert.notEqual(context.hashContext([], img('AAAA')), context.hashContext([], img('BBBB')));
});
test('D4.02 image MIME type and ordering affect fingerprint', () => {
  const a = { mimeType: 'image/png', data: 'AAAA' }, b = { mimeType: 'image/jpeg', data: 'AAAA' };
  assert.notEqual(context.hashContext([], [a]), context.hashContext([], [b]));
  assert.notEqual(context.hashContext([], [a, b]), context.hashContext([], [b, a]));
});
test('D4.03 upstream image bytes are included in graph fingerprint', () => {
  const nodes = value => upstream({ attachments: [{ id: 'image', type: 'image/png', content: value, name: 'image' }] });
  assert.notEqual(context.upstreamFingerprint('b', nodes('AAAA'), [edge]), context.upstreamFingerprint('b', nodes('BBBB'), [edge]));
});
test('D4.04 collapse and display summary do not mark dependencies stale', () => {
  assert.equal(context.upstreamFingerprint('b', upstream(), [edge]), context.upstreamFingerprint('b', upstream({ isCollapsed: true, summaries: ['summary'] }), [edge]));
});
test('D4.05 visible upstream edits and context edge removal change fingerprint', () => {
  const old = context.upstreamFingerprint('b', upstream(), [edge]);
  assert.notEqual(old, context.upstreamFingerprint('b', upstream({ response: 'changed' }), [edge]));
  assert.notEqual(old, context.upstreamFingerprint('b', upstream(), []));
});
test('D4.06 hidden quick-note details do not mark dependencies stale', () => {
  assert.equal(context.upstreamFingerprint('b', upstream({ editMode: 'manual', response: 'old' }), [edge]), context.upstreamFingerprint('b', upstream({ editMode: 'manual', response: 'new' }), [edge]));
});
test('D4.07 stream completion retains request-time fingerprint', async () => {
  reset(upstream(), [edge]); edit('b', { isLoading: true });
  setModelsCache({ models: [{ id: 'test', name: 'test', provider: 'test', vision: true }], default: 'test' });
  const expected = context.upstreamFingerprint('b', state().nodes, state().edges);
  const previousFetch = globalThis.fetch;
  let dispatch;
  const dispatched = new Promise(resolve => { dispatch = resolve; });
  let respond;
  const response = new Promise(resolve => { respond = resolve; });
  globalThis.fetch = async () => { dispatch(); return response; };
  try {
    const generation = streaming.runNodeGeneration(useStore.setState, useStore.getState, 'b', { question: 'b', messages: [{ role: 'user', content: 'before' }] });
    await dispatched; edit('a', { response: 'upstream edited during stream' });
    respond(new Response('data: {"text":"final answer"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    await generation;
    assert.equal(state().nodes[1].data.response, 'final answer');
    assert.equal(state().nodes[1].data.lastContextHash, expected);
    assert.equal(state().nodes[1].data.responseVersions[0].contextHash, expected);
    assert.notEqual(expected, context.upstreamFingerprint('b', state().nodes, state().edges));
  } finally { globalThis.fetch = previousFetch; }
});
test('D4.08 identical serialized inputs are deterministic', () => {
  const nodes = upstream(); assert.equal(context.upstreamFingerprint('b', nodes, [edge]), context.upstreamFingerprint('b', JSON.parse(JSON.stringify(nodes)), [edge]));
});

test('D5.01 successful switch clears project-local filters and selection', async () => {
  await setupProjects(); useUiStore.setState({ knowledgeQuery: { tagIds: ['only-in-a'], customTypeIds: ['type-a'] }, activeNodeId: 'source', localDepth: 2, selectedOrganizationRelationId: 'relation-a' });
  await projects.switchProject('b');
  assert.deepEqual(useUiStore.getState().knowledgeQuery, {}); assert.equal(useUiStore.getState().activeNodeId, null);
  assert.equal(useUiStore.getState().selectedOrganizationRelationId, null); assert.equal(useUiStore.getState().localDepth, 0);
});
test('D5.02 failed switch preserves the current filters', async () => {
  await setupProjects(true); const query = { text: 'source', tagIds: ['tag-a'] }; useUiStore.setState({ knowledgeQuery: query });
  await assert.rejects(projects.switchProject('b')); assert.deepEqual(useUiStore.getState().knowledgeQuery, query);
});
test('D5.03 current-project navigation preserves filters and view preference', async () => {
  await setupProjects(); useUiStore.setState({ knowledgeQuery: { text: 'source' }, canvasView: 'card' });
  await projects.switchProject('a'); assert.deepEqual(useUiStore.getState().knowledgeQuery, { text: 'source' });
  await projects.switchProject('b'); assert.equal(useUiStore.getState().canvasView, 'card');
});

const desktop = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url)));
test('D6.01 fork application identity and protocol are isolated', () => {
  assert.equal(desktop.build.appId, 'io.github.includeno.thoughtdag');
  assert.equal(desktop.build.productName, 'ThoughtDAG Includeno');
  assert.deepEqual(desktop.build.protocols[0].schemes, ['thoughtdag-includeno']);
});
test('D6.02 updater and download use the package publisher', () => {
  assert.equal(releases.releaseApi, 'https://api.github.com/repos/includeno/thoughtdag/releases/latest');
  assert.equal(releases.releaseDownload, 'https://github.com/includeno/thoughtdag/releases/latest');
});
for (const [label, current, candidate, expected] of [
  ['new patch', '0.4.3', 'v0.4.4', true], ['new minor', '0.4.9', '0.10.0', true],
  ['equal release', '0.4.3', 'v0.4.3', false], ['older release', '0.4.3', '0.4.2', false],
  ['prerelease', '0.4.3', '0.5.0-beta.1', false], ['invalid tag', '0.4.3', 'latest', false],
  ['unknown current', 'dev', '0.5.0', false],
]) test(`D6.03 ${label}`, () => assert.equal(releases.isNewerRelease(current, candidate), expected));

await runTests(tests);
