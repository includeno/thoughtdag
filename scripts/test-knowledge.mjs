import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import ts from 'typescript';

// Keep the production module as TypeScript without adding a test-runtime
// dependency: transpile this one pure file in memory, then exercise its JS.
const sourceUrl = new URL('../src/lib/knowledge.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  },
  fileName: sourceUrl.pathname,
  reportDiagnostics: true,
});
const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (errors.length > 0) {
  const host = {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  };
  throw new Error(ts.formatDiagnostics(errors, host));
}
const knowledge = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);

const {
  checkOrganizationRelation,
  findParentCycles,
  groupKnowledgeCardsByTime,
  knowledgeQueryIsActive,
  projectActiveNeighborhood,
  projectKnowledgeQuery,
  resolveKnowledgeQuery,
  projectKnowledgeTree,
  queryKnowledgeNodes,
} = knowledge;

function node(id, patch = {}) {
  const { kind, question = id, response = '', ...dataPatch } = patch;
  return {
    id,
    type: 'thought',
    position: { x: 0, y: 0 },
    data: {
      question,
      response,
      responses: response ? [response] : [],
      responseIndex: response ? 0 : -1,
      isCollapsed: false,
      isEditing: false,
      isEditingResponse: false,
      isLoading: false,
      tokenCount: 0,
      highlights: [],
      highlightMode: 'off',
      attachments: [],
      excludedAttachmentIds: [],
      includedAttachmentIds: [],
      roleMode: 'inherit',
      isRoot: false,
      isBranch: false,
      ...(kind ? { stepKind: kind } : {}),
      ...dataPatch,
    },
  };
}

function edge(id, source, target, reference = false) {
  return { id, source, target, data: reference ? { isCrossLink: true } : {} };
}

function relation(id, sourceId, targetId, kind = 'parent', createdAt = '2026-08-01T00:00:00.000Z') {
  return { id, sourceId, targetId, kind, createdAt };
}

function flattenTree(items) {
  return items.flatMap((item) => [item, ...flattenTree(item.children)]);
}

function ids(value) {
  return [...value].sort();
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('organization relation validation keeps parent acyclic and jump direction explicit', () => {
  const existing = [
    relation('p-ab', 'a', 'b'),
    relation('p-bc', 'b', 'c'),
    relation('j-xy', 'x', 'y', 'jump'),
  ];
  assert.deepEqual(checkOrganizationRelation(existing, { sourceId: 'c', targetId: 'a', kind: 'parent' }), {
    ok: false,
    reason: 'parent-cycle',
    cyclePath: ['c', 'a', 'b', 'c'],
  });
  assert.deepEqual(checkOrganizationRelation(existing, { sourceId: 'x', targetId: 'y', kind: 'jump' }), {
    ok: false,
    reason: 'duplicate',
  });
  assert.deepEqual(checkOrganizationRelation(existing, { sourceId: 'y', targetId: 'x', kind: 'jump' }), { ok: true });
  assert.deepEqual(checkOrganizationRelation(existing, { sourceId: 'c', targetId: 'a', kind: 'jump' }), { ok: true });
  assert.deepEqual(checkOrganizationRelation(existing, { sourceId: 'z', targetId: 'z', kind: 'jump' }), {
    ok: false,
    reason: 'self-loop',
  });
  assert.deepEqual(findParentCycles([
    relation('p-ab', 'a', 'b'),
    relation('p-ba', 'b', 'a'),
    relation('j-bc', 'b', 'c', 'jump'),
  ]), [['a', 'b', 'a']]);
});

const graphNodes = [
  node('a'), node('b'), node('c'), node('d'), node('s'), node('x'),
  node('p'), node('o'), node('j'), node('z'), node('orphan'),
];
const graphEdges = [
  edge('e-ab', 'a', 'b'),
  edge('e-bc', 'b', 'c'),
  edge('e-cd', 'c', 'd'),
  edge('e-as', 'a', 's'),
  edge('ref-xb', 'x', 'b', true),
];
const graphRelations = [
  relation('org-pb', 'p', 'b'),
  relation('org-bo', 'b', 'o'),
  relation('jump-bj', 'b', 'j', 'jump'),
  relation('jump-jz', 'j', 'z', 'jump'),
];
const graph = { nodes: graphNodes, edges: graphEdges, organizationRelations: graphRelations };

test('active neighborhood includes every direct role, siblings, and exactly one extra layer', () => {
  const one = projectActiveNeighborhood(graph, 'b', 1);
  assert.deepEqual(ids(one.nodeIds), ids(['a', 'b', 'c', 's', 'x', 'p', 'o', 'j']));
  assert.equal(one.distanceByNodeId.b, 0);
  assert.deepEqual(one.rolesByNodeId.a, ['upstream']);
  assert.deepEqual(one.rolesByNodeId.c, ['downstream']);
  assert.deepEqual(one.rolesByNodeId.s, ['sibling']);
  assert.deepEqual(one.rolesByNodeId.x, ['reference']);
  assert.deepEqual(one.rolesByNodeId.p, ['organization-parent']);
  assert.deepEqual(one.rolesByNodeId.o, ['organization-child']);
  assert.deepEqual(one.rolesByNodeId.j, ['jump']);
  assert.ok(!one.nodeIds.includes('d'));
  assert.ok(!one.nodeIds.includes('z'));

  const two = projectActiveNeighborhood(graph, 'b', 2);
  assert.deepEqual(ids(two.nodeIds), ids(['a', 'b', 'c', 'd', 's', 'x', 'p', 'o', 'j']));
  assert.equal(two.distanceByNodeId.d, 2);
  assert.deepEqual(two.rolesByNodeId.d, ['extended']);
  assert.ok(two.contextEdgeIds.includes('e-cd'));
  assert.ok(!two.organizationRelationIds.includes('jump-jz'));
  assert.ok(!two.nodeIds.includes('orphan'));
});

const queryNodes = [
  node('alpha', {
    question: 'Alpha decision alpha',
    response: 'Evidence',
    customTypeId: 'decision',
    tagIds: ['red', 'urgent'],
    createdAt: '2026-08-20T18:30:00.000Z',
  }),
  node('archived-note', {
    kind: 'note',
    question: 'Alpha field note',
    customTypeId: 'source',
    tagIds: ['red'],
    createdAt: '2026-08-21T08:00:00.000Z',
    archived: true,
  }),
  node('child', { question: 'Child', createdAt: '2026-08-22T08:00:00.000Z' }),
  node('grandchild', { question: 'Grandchild', createdAt: '2026-08-23T08:00:00.000Z' }),
  node('parent', { question: 'Parent', createdAt: '2026-08-19T08:00:00.000Z' }),
  node('reference', { question: 'Reference', createdAt: '2026-08-18T08:00:00.000Z' }),
  node('org-parent', { question: 'Organization parent', createdAt: '2026-08-17T08:00:00.000Z' }),
  node('jump', { question: 'Jump', createdAt: '2026-08-16T08:00:00.000Z' }),
  node('lonely', { question: 'No relations' }),
];
const queryGraph = {
  nodes: queryNodes,
  edges: [
    edge('e-parent-alpha', 'parent', 'alpha'),
    edge('e-alpha-child', 'alpha', 'child'),
    edge('e-child-grandchild', 'child', 'grandchild'),
    edge('ref-reference-alpha', 'reference', 'alpha', true),
  ],
  organizationRelations: [
    relation('org-parent-alpha', 'org-parent', 'alpha'),
    relation('jump-alpha-jump', 'alpha', 'jump', 'jump'),
  ],
};

test('query combines text, system/custom/tag/date/archive filters with AND semantics', () => {
  const filtered = queryKnowledgeNodes(queryGraph, {
    systemKinds: ['qa'],
    customTypeIds: ['decision'],
    tagIds: ['red', 'urgent'],
    createdAt: { from: '2026-08-20', to: '2026-08-20' },
    archived: 'active',
  });
  assert.deepEqual(filtered.nodeIds, ['alpha']);
  assert.deepEqual(filtered.hits[0].matchedFields, []);

  const withText = queryKnowledgeNodes(queryGraph, {
    text: 'alpha',
    tagIds: ['red'],
    tagMatch: 'any',
    archived: 'any',
  });
  assert.deepEqual(withText.nodeIds, ['alpha', 'archived-note']);
  assert.equal(withText.hits[0].occurrenceCount, 2);
  assert.deepEqual(withText.hits[0].matchedFields, ['question']);

  assert.deepEqual(queryKnowledgeNodes(queryGraph, { archived: 'archived' }).nodeIds, ['archived-note']);
  assert.throws(
    () => queryKnowledgeNodes(queryGraph, { createdAt: { from: 'not-a-date' } }),
    /Invalid date boundary/,
  );
});

test('text query only searches the current question, response, and summary version', () => {
  const versioned = node('versioned', {
    question: 'Current question',
    questions: ['Legacy question needle', 'Current question'],
    response: 'Current response',
    responses: ['Legacy response needle', 'Current response'],
    responseIndex: 1,
    summary: 'Legacy summary needle',
    summaries: ['Legacy summary needle', 'Current summary'],
  });
  assert.deepEqual(queryKnowledgeNodes({ nodes: [versioned] }, { text: 'needle' }).nodeIds, []);
  assert.deepEqual(queryKnowledgeNodes({ nodes: [versioned] }, { text: 'current response' }).nodeIds, ['versioned']);
  assert.deepEqual(queryKnowledgeNodes({ nodes: [versioned] }, { text: 'current summary' }).nodeIds, ['versioned']);
});

test('shared projection intersects filters with the local neighborhood and retains an unmatched anchor', () => {
  const localGraph = {
    nodes: [
      node('active'),
      node('near', { tagIds: ['wanted'] }),
      node('far', { tagIds: ['wanted'] }),
    ],
    edges: [edge('active-near', 'active', 'near')],
    organizationRelations: [],
  };
  const query = { tagIds: ['wanted'] };
  const projected = projectKnowledgeQuery(localGraph, query, { activeNodeId: 'active', localDepth: 1 });
  assert.equal(knowledgeQueryIsActive(query), true);
  assert.deepEqual(projected.candidateNodeIds, ['active', 'near']);
  assert.deepEqual(projected.matchedNodeIds, ['near']);
  assert.deepEqual(projected.visibleNodeIds, ['active', 'near']);
  assert.equal(projected.activeOutsideFilter, true);
  assert.ok(!projected.matchedNodeIds.includes('far'));

  const unfiltered = projectKnowledgeQuery(localGraph, {}, { activeNodeId: 'active', localDepth: 1 });
  assert.deepEqual(unfiltered.matchedNodeIds, ['active', 'near']);
  assert.deepEqual(unfiltered.visibleNodeIds, ['active', 'near']);
  assert.equal(unfiltered.activeOutsideFilter, false);
});

test('relation scopes are deterministic and keep context/organization domains explicit', () => {
  const persistedQuery = { relation: { scope: 'descendants', domain: 'context' } };
  const effectiveQuery = resolveKnowledgeQuery(persistedQuery, 'alpha');
  assert.equal(persistedQuery.relation.anchorNodeId, undefined);
  assert.equal(effectiveQuery.relation.anchorNodeId, 'alpha');
  assert.deepEqual(
    projectKnowledgeQuery(queryGraph, effectiveQuery).matchedNodeIds,
    ['child', 'grandchild'],
  );
  assert.deepEqual(
    ids(queryKnowledgeNodes(queryGraph, { relation: { scope: 'ancestors', anchorNodeId: 'grandchild' } }).nodeIds),
    ids(['alpha', 'child', 'parent', 'org-parent']),
  );
  assert.deepEqual(
    ids(queryKnowledgeNodes(queryGraph, { relation: { scope: 'descendants', anchorNodeId: 'alpha' } }).nodeIds),
    ids(['child', 'grandchild']),
  );
  assert.deepEqual(
    ids(queryKnowledgeNodes(queryGraph, { relation: { scope: 'branch', anchorNodeId: 'alpha' } }).nodeIds),
    ids(['alpha', 'child', 'grandchild', 'parent', 'org-parent']),
  );
  assert.deepEqual(
    ids(queryKnowledgeNodes(queryGraph, { relation: { scope: 'backlinks', anchorNodeId: 'alpha' } }).nodeIds),
    ids(['reference', 'org-parent']),
  );
  assert.deepEqual(
    queryKnowledgeNodes(queryGraph, { relation: { scope: 'orphans' } }).nodeIds,
    ['archived-note', 'lonely'],
  );
  assert.deepEqual(
    queryKnowledgeNodes(queryGraph, { relation: { scope: 'ancestors', anchorNodeId: 'grandchild', domain: 'organization' } }).nodeIds,
    [],
  );
});

test('tree projection repeats multi-parent nodes and terminates rootless cycles', () => {
  const nodes = ['root-1', 'root-2', 'shared', 'leaf', 'cycle-1', 'cycle-2', 'alone'].map((id) => node(id));
  const organizationRelations = [
    relation('p-r1-shared', 'root-1', 'shared'),
    relation('p-r2-shared', 'root-2', 'shared'),
    relation('p-shared-leaf', 'shared', 'leaf'),
    relation('p-c1-c2', 'cycle-1', 'cycle-2'),
    relation('p-c2-c1', 'cycle-2', 'cycle-1'),
    relation('j-shared-alone', 'shared', 'alone', 'jump'),
  ];
  const projection = projectKnowledgeTree({ nodes, organizationRelations });
  const flat = flattenTree(projection.roots);
  assert.equal(flat.filter((item) => item.nodeId === 'shared').length, 2);
  assert.ok(flat.filter((item) => item.nodeId === 'shared').every((item) => item.multiParent));
  assert.ok(flat.some((item) => item.nodeId === 'cycle-1' && item.cycle));
  assert.equal(projection.cycleRelationIds.length, 1);
  assert.equal(projection.truncated, false);
  assert.ok(projection.roots.some((item) => item.nodeId === 'cycle-1'));
  assert.deepEqual(flat.find((item) => item.nodeId === 'shared').jumpNodeIds, ['alone']);
});

test('card projection groups in UTC and sorts groups and cards deterministically', () => {
  const cards = [
    node('morning', { createdAt: '2026-08-20T08:00:00.000Z' }),
    node('evening', { createdAt: '2026-08-20T20:00:00.000Z' }),
    node('next-day', { createdAt: '2026-08-21T09:00:00.000Z' }),
    node('undated'),
  ];
  const groups = groupKnowledgeCardsByTime({ nodes: cards });
  assert.deepEqual(groups.map((group) => group.key), ['2026-08-21', '2026-08-20', 'undated']);
  assert.deepEqual(groups[1].nodeIds, ['evening', 'morning']);
  assert.deepEqual(groups[2].nodeIds, ['undated']);
  const oldest = groupKnowledgeCardsByTime({ nodes: cards }, { direction: 'oldest', nodeIds: ['morning', 'next-day'] });
  assert.deepEqual(oldest.map((group) => group.key), ['2026-08-20', '2026-08-21']);
});

let passed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}
console.log(`knowledge tests: ${passed}/${tests.length} passed`);
