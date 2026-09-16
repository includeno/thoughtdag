import assert from 'node:assert/strict';
import { load, node, reset, useStore, runTests } from './fixtures/store-runtime.mjs';
const { buildContext, referenceBlockContent } = await load('/src/store/context-builder.ts');
const { editModePatch } = await load('/src/lib/edit-mode.ts');
const tests = [];
const test = (name, run) => tests.push([name, run]);
const edge = { id: 'a-b', source: 'a', target: 'b' };
const context = (data, cross = false) => buildContext('b', [node('a', data), node('b', { response: '' })], [{ ...edge, data: { isCrossLink: cross } }]);

test('A1.01 quick note excludes retained answer on structural chain', () => {
  assert.deepEqual(context({ editMode: 'manual' }).messages.map(m => m.content), ['a', 'b']);
});
test('A1.02 quick note excludes highlights of hidden answer', () => {
  assert(!JSON.stringify(context({ editMode: 'manual', highlightMode: 'filter', highlights: [{ id: 'h', text: 'secret' }] })).includes('secret'));
});
test('A1.03 structured details are user-authored material', () => {
  assert.deepEqual(context({ editMode: 'manual-detail' }).messages[1], { role: 'user', content: '[Note]\nanswer' });
});
test('A1.04 legacy AI response keeps assistant role', () => {
  assert.equal(context({}).messages[1].role, 'assistant');
});
test('A1.05 quote reference respects quick note mode', () => {
  assert(!JSON.stringify(context({ editMode: 'manual' }, true).messages).includes('answer'));
});
test('A1.06 full reference labels structured notes as notes', () => {
  const a = node('a', { editMode: 'manual-detail' });
  const text = referenceBlockContent({ source: a, chain: [], edge, depth: 'full' });
  assert(text.includes('Note: answer')); assert(!text.includes('A: answer'));
});
test('A1.07 mode roundtrip retains content and restores AI semantics', () => {
  let data = node('a').data;
  data = { ...data, ...editModePatch(data, 'manual') };
  assert.equal(data.response, 'answer');
  data = { ...data, ...editModePatch(data, 'ai') };
  assert.equal(context(data).messages[1].role, 'assistant');
});
test('A1.08 legacy note remains material', () => {
  const messages = context({ stepKind: 'note' }).messages;
  assert(messages.some(m => m.content === '[Note]\na'));
  assert(!messages.some(m => m.role === 'assistant'));
});
test('A1.09 mode validation rejects unsupported kind and active stream', () => {
  assert.throws(() => editModePatch(node('a', { stepKind: 'file' }).data, 'ai'));
  assert.throws(() => editModePatch(node('a', { isLoading: true }).data, 'manual'));
  assert.throws(() => editModePatch(node('a').data, 'unknown'));
});
test('A1.10 mode change is undoable without discarding details', () => {
  reset([node('a')]); useStore.getState().setNodeEditMode('a', 'manual');
  assert.equal(useStore.getState().nodes[0].data.response, 'answer');
  useStore.getState().undo(); assert.equal(useStore.getState().nodes[0].data.editMode, undefined);
});

const { queryKnowledgeNodes, projectKnowledgeQuery, projectKnowledgeTree, groupKnowledgeCardsByTime } = await load('/src/lib/knowledge.ts');
const { responseVersions, withResponseVersions, editResponseVersion, hasValidResponseVersions } = await load('/src/lib/response-versions.ts');
test('A2.01 query supplies exact whitespace-preserving excerpt', () => {
  const hit = queryKnowledgeNodes({ nodes: [node('a', { question: 'before  NEEDLE after' })] }, { text: 'needle' }).hits[0];
  assert.equal(hit.excerpt.snippet.slice(hit.excerpt.matchStart, hit.excerpt.matchStart + hit.excerpt.matchLen), 'NEEDLE');
});
test('A2.02 excerpt clips long prefixes without shifting highlight', () => {
  const hit = queryKnowledgeNodes({ nodes: [node('a', { question: 'x'.repeat(200) + 'needle' })] }, { text: 'needle' }).hits[0];
  assert.equal(hit.excerpt.matchStart, 41); assert.equal(hit.excerpt.snippet.slice(41), 'needle');
});
test('A2.03 metadata-only queries need no text snippets', () => {
  const result = queryKnowledgeNodes({ nodes: [node('a', { tagIds: ['t'] }), node('b')] }, { tagIds: ['t'] });
  assert.deepEqual(result.nodeIds, ['a']); assert.equal(result.hits[0].excerpt, undefined);
});
test('A2.04 local projection keeps anchor without counting it as match', () => {
  const graph = { nodes: [node('a'), node('b', { question: 'needle' }), node('c')], edges: [edge] };
  const result = projectKnowledgeQuery(graph, { text: 'needle' }, { activeNodeId: 'a', localDepth: 1 });
  assert.deepEqual(result.matchedNodeIds, ['b']); assert.deepEqual(result.visibleNodeIds, ['a', 'b']);
});
test('A2.05 empty graph and no matches are safe in every projection', () => {
  assert.deepEqual(projectKnowledgeQuery({ nodes: [] }).hits, []);
  assert.deepEqual(projectKnowledgeTree({ nodes: [] }).roots, []);
  assert.deepEqual(groupKnowledgeCardsByTime({ nodes: [] }), []);
});
test('A2.06 thousands of results are deterministic without mutating graph', () => {
  const nodes = Array.from({ length: 2500 }, (_, i) => node(String(i), { question: 'needle' }));
  const before = JSON.stringify(nodes); const result = queryKnowledgeNodes({ nodes }, { text: 'needle' });
  assert.equal(result.hits.length, 2500); assert.equal(JSON.stringify(nodes), before);
  assert.deepEqual(result.nodeIds, queryKnowledgeNodes({ nodes }, { text: 'needle' }).nodeIds);
});
const version = (id, patch = {}) => ({ id, question: id, response: 'answer-' + id, author: 'model', ...patch });
test('A3.01 legacy migration preserves parallel metadata and unknown provenance', () => {
  const versions = responseVersions(node('a', { responses: ['one', 'two'], responseIndex: 1, generatedBy: ['m'], references: [{ title: 'latest' }] }).data);
  assert.equal(versions[0].author, 'model'); assert.equal(versions[1].author, 'unknown');
  assert.equal(versions[0].references, undefined); assert.deepEqual(versions[1].references, [{ title: 'latest' }]);
});
test('A3.02 selecting old version restores its sources and context hash', () => {
  const versions = [version('old', { references: [{ title: 'old source' }], contextHash: 'old-hash' }), version('new', { contextHash: 'new-hash' })];
  reset([node('a', withResponseVersions(node('a').data, versions, 1))]);
  useStore.getState().navigateVersion('a', 'prev');
  assert.equal(useStore.getState().nodes[0].data.lastContextHash, 'old-hash');
  assert.deepEqual(useStore.getState().nodes[0].data.references, [{ title: 'old source' }]);
});
test('A3.03 unknown old sources clear newer sources instead of misattributing', () => {
  const data = withResponseVersions(node('a', { references: [{ title: 'new' }] }).data, [version('old')], 0);
  assert.equal(data.references, undefined); assert.equal(data.lastContextHash, undefined);
});
test('A3.04 deleting an earlier version preserves active identity and all metadata', () => {
  const versions = [version('a'), version('b'), version('c', { gatewaySearch: true, summaryTopic: 'topic' })];
  reset([node('a', withResponseVersions(node('a').data, versions, 2))]); useStore.getState().deleteVersion('a', 0);
  const data = useStore.getState().nodes[0].data;
  assert.equal(data.responseIndex, 1); assert.equal(data.responseVersions[1].id, 'c');
  assert.equal(data.gatewaySearches[1], true); assert.equal(data.summaryTopics[1], 'topic');
});
test('A3.05 invalid deletion and last-version deletion are no-ops', () => {
  reset([node('a')]); useStore.getState().deleteVersion('a', -1); useStore.getState().deleteVersion('a', 0);
  assert.deepEqual(useStore.getState().nodes[0].data.responses, ['answer']);
});
test('A3.06 empty version navigation does not create undefined response', () => {
  reset([node('a', { responses: [], response: '', responseIndex: -1 })]); useStore.getState().navigateVersion('a', 'prev');
  assert.equal(useStore.getState().nodes[0].data.response, ''); assert.equal(useStore.getState().nodes[0].data.responseIndex, -1);
});
test('A3.07 user revision clears derived summaries but keeps model provenance', () => {
  const data = withResponseVersions(node('a').data, [version('v', { model: 'model', summary: 'old', summaryTopic: 'old' })]);
  const edited = editResponseVersion(data, 'revised', 'revised question');
  assert.equal(edited.responseVersions[0].author, 'user'); assert.equal(edited.generatedBy[0], 'model');
  assert.equal(edited.summaries[0], undefined); assert.equal(edited.questions[0], 'revised question');
});
test('A3.08 late summary targets version id even when texts repeat', () => {
  const versions = [version('one', { response: 'same' }), version('two', { response: 'same' })];
  reset([node('a', withResponseVersions(node('a').data, versions, 0))]);
  useStore.getState().setSummary('a', 'summary two', 'same', 'insight', 'topic', 'two');
  assert.equal(useStore.getState().nodes[0].data.summaries[0], undefined);
  assert.equal(useStore.getState().nodes[0].data.summaries[1], 'summary two');
});
test('A3.09 late summary cannot clobber streaming draft', () => {
  reset([node('a', { ...withResponseVersions(node('a').data, [version('v')]), response: 'partial', isLoading: true })]);
  useStore.getState().setSummary('a', 'summary', 'answer-v', 'insight', undefined, 'v');
  assert.equal(useStore.getState().nodes[0].data.response, 'partial');
});
test('A3.10 record validation rejects duplicate ids and malformed sources', () => {
  assert(!hasValidResponseVersions({ responseVersions: [version('same'), version('same')] }));
  assert(!hasValidResponseVersions({ responseVersions: [version('v', { references: [{ title: 1 }] })] }));
  assert(!hasValidResponseVersions({ responseVersions: [version('v', { author: 'invalid' })] }));
});
test('A3.11 serialization roundtrip preserves complete versions', () => {
  const data = withResponseVersions(node('a').data, [version('v', { contextHash: 'h', references: [{ title: 'source', url: 'https://example.com' }] })]);
  assert.deepEqual(responseVersions(JSON.parse(JSON.stringify(data))), JSON.parse(JSON.stringify(data.responseVersions)));
});
test('A3.12 version deletion remains reversible', () => {
  reset([node('a', withResponseVersions(node('a').data, [version('one'), version('two')], 1))]);
  useStore.getState().deleteVersion('a', 1); useStore.getState().undo();
  assert.equal(useStore.getState().nodes[0].data.responseVersions[1].id, 'two');
});

await runTests(tests);
