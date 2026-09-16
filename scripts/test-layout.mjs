#!/usr/bin/env node
// Layout invariants. autoLayout is pure, but it lives in src/ where the module
// graph reaches import.meta.env, so it is bundled for node the same way the
// benchmark compiler bundles product code (benchmark/tools/build-bundle.sh).
//
// The rules being checked are the canvas grammar, not aesthetics:
//   - a node CONTINUES below every parent it continues from
//   - a node EXPLORED out of a parent stands beside it, never above its top
//   - no two thought cards overlap
//   - the same graph, handed over in a different order, lays out the same way
//
// Run: node scripts/test-layout.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'tdag-layout-'));
const bundle = join(tmp, 'layout.mjs');
execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
  join(ROOT, 'src/lib/layout.ts'), '--bundle', '--format=esm', '--platform=node',
  `--outfile=${bundle}`, '--define:import.meta.env.VITE_API_BASE=""',
  '--define:import.meta.env.DEV=false',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const { autoLayout, nodeHeight } = await import(pathToFileURL(bundle).href);

const routeBundle = join(tmp, 'edge-path.mjs');
execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
  join(ROOT, 'src/lib/edge-path.ts'), '--bundle', '--format=esm', '--platform=node',
  `--outfile=${routeBundle}`, '--define:import.meta.env.VITE_API_BASE=""', '--define:import.meta.env.DEV=false',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const { routeEdge } = await import(pathToFileURL(routeBundle).href);

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const NODE_W = 520;
const CONTENT = new Set(['note', 'file', 'link', 'frame']);
const th = (id, over = {}) => ({
  id, type: 'thought', position: { x: 0, y: 0 },
  data: {
    question: 'q', response: 'r', responses: ['r'], responseIndex: 0,
    isCollapsed: true, isEditing: false, isEditingResponse: false, isLoading: false,
    tokenCount: 0, highlights: [], highlightMode: false, roleMode: 'assistant',
    attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
    isRoot: false, isBranch: false, ...over,
  },
});
const file = (id, x) => ({ ...th(id, { stepKind: 'file' }), position: { x, y: 0 }, measured: { width: 120, height: 120 } });
const frame = (id, x, y, width, height, frameCarry = true) => ({
  ...th(id, { stepKind: 'frame', frameCarry }), position: { x, y }, width, height, zIndex: -1,
});
const placed = (node, x, y, width = 520, height = 120) => ({
  ...node, position: { x, y }, measured: { width, height },
});
const ed = (s, t, data) => ({ id: `${s}->${t}`, source: s, target: t, ...(data ? { data } : {}) });
const xOf = (laid, id) => laid.find((n) => n.id === id).position.x;
const nodeOf = (laid, id) => laid.find((n) => n.id === id);

// Every arrow-order and overlap rule, checked per edge.
function violations(laid, edges) {
  const by = new Map(laid.map((n) => [n.id, n]));
  const out = [];
  for (const e of edges) {
    if (e.data?.isCrossLink) continue;
    const s = by.get(e.source), t = by.get(e.target);
    if (!s || !t || CONTENT.has(s.data?.stepKind) || CONTENT.has(t.data?.stepKind)) continue;
    if (e.data?.isBranchFromSelection) {
      if (t.position.y < s.position.y) out.push(`explore ${e.source}->${e.target} above parent top`);
    } else if (t.position.y < s.position.y + nodeHeight(s)) {
      out.push(`structural ${e.source}->${e.target} above parent bottom`);
    }
  }
  const solid = laid.filter((n) => !CONTENT.has(n.data?.stepKind));
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    const a = solid[i], b = solid[j];
    if (a.position.x < b.position.x + NODE_W && b.position.x < a.position.x + NODE_W &&
        a.position.y < b.position.y + nodeHeight(b) && b.position.y < a.position.y + nodeHeight(a))
      out.push(`overlap ${a.id}/${b.id}`);
  }
  return out;
}

console.log('layout invariants\n');

test('a merge sits under the parent it was continued from: the first edge in, not the median', () => {
  const nodes = ['root', 'p1', 'p2', 'p3', 'merge'].map((i) => th(i));
  const edges = [ed('root', 'p1'), ed('root', 'p2'), ed('root', 'p3'),
                 ed('p3', 'merge'), ed('p1', 'merge'), ed('p2', 'merge')];
  const laid = autoLayout(nodes, edges);
  assert(xOf(laid, 'merge') === xOf(laid, 'p3'),
    `merge at ${xOf(laid, 'merge')}, first parent p3 at ${xOf(laid, 'p3')}`);
});

test('the same graph in a different node order lays out the same way', () => {
  const ids = ['root', 'p1', 'p2', 'p3', 'merge'];
  const edges = [ed('root', 'p1'), ed('root', 'p2'), ed('root', 'p3'),
                 ed('p1', 'merge'), ed('p2', 'merge'), ed('p3', 'merge')];
  const byId = new Map(ids.map((i) => [i, th(i)]));
  const sig = (order) => autoLayout(order.map((i) => byId.get(i)), edges)
    .map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).sort().join('|');
  const a = sig(ids), b = sig([...ids].reverse()), c = sig(['root', 'p3', 'p1', 'p2', 'merge']);
  assert(a === b && b === c, 'layout changed when the node array was permuted');
});

test('an explore branch follows the merge that moves beneath its parents', () => {
  const nodes = ['rootA', 'rootB', 'B', 'merge', 'branch'].map((i) => th(i));
  const edges = [ed('rootB', 'B'), ed('rootA', 'merge'), ed('B', 'merge'),
                 ed('merge', 'branch', { isBranchFromSelection: true })];
  const laid = autoLayout(nodes, edges);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a merge continued from one parent and explored from another keeps the plain column', () => {
  const nodes = ['explore', 'a', 'b', 'plain', 'merge'].map((i) => th(i));
  const edges = [ed('a', 'b'), ed('b', 'plain'),
                 ed('explore', 'merge', { isBranchFromSelection: true }), ed('plain', 'merge')];
  const laid = autoLayout(nodes, edges);
  assert(xOf(laid, 'merge') === xOf(laid, 'plain'),
    `merge at ${xOf(laid, 'merge')}, plain parent at ${xOf(laid, 'plain')}`);
});

test('a merge of material-anchored chains follows its first parent, wherever that chain sits', () => {
  const nodes = [file('mLeft', 0), file('mMid', 1000), file('mRight', 2000),
                 th('qRight'), th('qLeft'), th('qMid'), th('merge')];
  const edges = [ed('mRight', 'qRight'), ed('mLeft', 'qLeft'), ed('mMid', 'qMid'),
                 ed('qRight', 'merge'), ed('qLeft', 'merge'), ed('qMid', 'merge')];
  const laid = autoLayout(nodes, edges);
  assert(xOf(laid, 'merge') === xOf(laid, 'qRight'),
    `merge at ${xOf(laid, 'merge')}, first parent qRight at ${xOf(laid, 'qRight')}`);
});

test('a chain reading several documents hangs from the lowest of them', () => {
  const nodes = [file('f0', 0), file('f1', 900), file('f2', 1800), file('f3', 2700), file('f4', 3600), th('synth')];
  nodes[3].position.y = 400; // f3 hangs lowest
  const edges = ['f0', 'f1', 'f2', 'f3', 'f4'].map((f) => ed(f, 'synth'));
  const x = xOf(autoLayout(nodes, edges), 'synth');
  assert(Math.abs(x - (2700 - 60)) < 1, `synthesis at ${x}, not under the lowest document f3`);
});

test('a linked frame re-wraps the members it contained before layout', () => {
  const nodes = [
    frame('frame', 0, 400, 700, 900),
    placed(th('root'), 100, 500, 520, 260),
    placed(th('child'), 100, 900, 520, 260),
  ];
  const laid = autoLayout(nodes, [ed('root', 'child')]);
  const f = nodeOf(laid, 'frame'), root = nodeOf(laid, 'root'), child = nodeOf(laid, 'child');
  const minX = Math.min(root.position.x, child.position.x);
  const maxX = Math.max(root.position.x + 520, child.position.x + 520);
  const minY = Math.min(root.position.y, child.position.y);
  const maxY = Math.max(root.position.y + nodeHeight(root), child.position.y + nodeHeight(child));
  assert(f.position.y < 0, `frame stayed near its old y=${f.position.y}`);
  assert(f.position.x < minX && f.position.y < minY, 'frame does not leave padding above/left of members');
  assert(f.position.x + f.width > maxX && f.position.y + f.height > maxY, 'frame does not enclose laid-out members');
});

test('an unlinked frame is untouched by auto layout', () => {
  const original = frame('frame', 0, 400, 700, 900, false);
  const laid = autoLayout([
    original,
    placed(th('root'), 100, 500),
    placed(th('child'), 100, 900),
  ], [ed('root', 'child')]);
  const f = nodeOf(laid, 'frame');
  assert(f.position.x === original.position.x && f.position.y === original.position.y, 'unlinked frame moved');
  assert(f.width === original.width && f.height === original.height, 'unlinked frame resized');
});

test('a linked frame with no members is untouched by auto layout', () => {
  const original = frame('empty', 2000, 2000, 700, 900);
  const laid = autoLayout([original, placed(th('root'), 0, 0)], []);
  const f = nodeOf(laid, 'empty');
  assert(f.position.x === original.position.x && f.position.y === original.position.y, 'empty frame moved');
  assert(f.width === original.width && f.height === original.height, 'empty frame resized');
});

test('nested frames re-wrap inner to outer with more room on the outer frame', () => {
  const nodes = [
    frame('outer', 0, 400, 760, 1050),
    frame('inner', 50, 450, 660, 950),
    placed(th('root'), 100, 500),
    placed(th('child'), 100, 900),
  ];
  const laid = autoLayout(nodes, [ed('root', 'child')]);
  const outer = nodeOf(laid, 'outer'), inner = nodeOf(laid, 'inner');
  assert(outer.position.x < inner.position.x, 'outer frame does not have more left padding');
  assert(outer.position.y < inner.position.y, 'outer frame does not have more top padding');
  assert(outer.position.x + outer.width > inner.position.x + inner.width, 'outer frame does not have more right padding');
  assert(outer.position.y + outer.height > inner.position.y + inner.height, 'outer frame does not have more bottom padding');
});

test('overlapping frames can share a member and both still follow it', () => {
  const nodes = [
    frame('leftFrame', 0, 400, 650, 700),
    frame('rightFrame', 150, 400, 650, 700),
    placed(th('root'), 100, 500, 520, 120),
  ];
  const laid = autoLayout(nodes, []);
  const root = nodeOf(laid, 'root');
  for (const id of ['leftFrame', 'rightFrame']) {
    const f = nodeOf(laid, id);
    assert(f.position.x < root.position.x && f.position.y < root.position.y, `${id} lost shared member`);
    assert(f.position.x + f.width > root.position.x + 520, `${id} no longer wraps shared member`);
  }
});

test('layout reserves the same expanded space for collapsed and open cards', () => {
  const nodes = ['parent', 'child', 'branch'].map((id, i) => th(id, { isCollapsed: false, response: '内容'.repeat(100 + i * 300) }));
  const edges = [ed('parent', 'child'), ed('parent', 'branch')];
  const open = autoLayout(nodes, edges).map(n => n.position);
  const folded = nodes.map(n => ({ ...n, data: { ...n.data, isCollapsed: true } }));
  assert(JSON.stringify(autoLayout(folded, edges).map(n => n.position)) === JSON.stringify(open), 'folded nodes must retain expanded clearance');
});

test('wide downward branches stay inside their vertical gap without curling', () => {
  for (const dx of [-1200, 0, 1200]) {
    const route = routeEdge(0, 500, 'bottom', dx, 572, 'top', 'source', 'target', []);
    const points = route.path.match(/-?\d+(?:\.\d+)?/g).map(Number);
    assert(points[3] >= 500 && points[3] <= points[5] && points[5] <= 572, 'Bezier controls must stay ordered between the handles');
  }
});

test('nested sibling branches reserve separate subtree columns', () => {
  for (const anchored of [false, true]) {
    const nodes = ['root', 'consumer', 'push', 'backlog', 'reliability', 'loss'].map(id => th(id));
    const edges = [ed('root', 'consumer'), ed('root', 'reliability'), ed('consumer', 'push'), ed('consumer', 'backlog'), ed('reliability', 'loss')];
    if (anchored) { nodes.unshift(file('material', 300)); edges.unshift(ed('material', 'root')); }
    const laid = autoLayout(nodes, edges);
    assert(xOf(laid, 'push') === xOf(laid, 'consumer'), 'first followup stays under its own parent');
    assert(xOf(laid, 'loss') === xOf(laid, 'reliability'), 'other chain stays vertical');
    assert(xOf(laid, 'backlog') > xOf(laid, 'consumer'), 'second followup gets a branch column');
    assert(xOf(laid, 'reliability') > xOf(laid, 'backlog'), 'unrelated parent must not occupy descendant branch column');
    assert(JSON.stringify(autoLayout(laid, edges)) === JSON.stringify(laid), 'subtree layout must be idempotent');
  }
});

test('spacing uses measured card sizes and repeated layout does not drift', () => {
  const nodes = ['root', 'child', 'sibling', 'followup'].map((id, i) =>
    placed(th(id, { isCollapsed: false }), i * 17, i * 11, 800, 950 + i * 40));
  const edges = [ed('root', 'child'), ed('root', 'sibling'), ed('child', 'followup')];
  const once = autoLayout(nodes, edges);
  assert(xOf(once, 'root') === xOf(once, 'child') && xOf(once, 'child') === xOf(once, 'followup'), 'continuation must stay vertical');
  assert(xOf(once, 'sibling') - xOf(once, 'child') >= 848, 'wide cards need horizontal clearance');
  for (const edge of edges) {
    const parent = nodeOf(once, edge.source), child = nodeOf(once, edge.target);
    assert(child.position.y >= parent.position.y + nodeHeight(parent) + 72, 'child must clear measured parent height');
  }
  let repeated = once;
  for (let i = 0; i < 5; i++) repeated = autoLayout(repeated, edges);
  assert(JSON.stringify(repeated) === JSON.stringify(once), 'repeated clicks must leave coordinates unchanged');
});

test('the benchmark canvases keep the arrow order', () => {
  const dir = join(ROOT, 'benchmark/canvases/inputs');
  let checked = 0, bad = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.thoughtdag.json'))) {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const v = violations(autoLayout(c.nodes ?? [], c.edges ?? []), c.edges ?? []);
    checked++;
    if (v.length) bad.push(`${f}: ${v[0]}`);
  }
  assert(checked > 0, 'no benchmark canvases found');
  assert(bad.length === 0, `${bad.length}/${checked} canvases violate: ${bad[0]}`);
});

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing` : '\nall passed');
process.exit(failures ? 1 : 0);
