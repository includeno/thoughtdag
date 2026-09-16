import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
});
const context = await browser.newContext({ locale: 'en-US' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.route('**/api/**', route => route.fulfill({ json: { models: [], default: null } }));
await page.addInitScript(() => {
  localStorage.setItem('thoughtdag.seeded', 'yes');
  localStorage.setItem('thoughtdag.tutorialDone', '1');
});
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
async function view(name) {
  await page.evaluate(async name => (await import('/src/lib/ui-store.ts')).useUiStore.getState().setCanvasView(name), name);
}
try {
  await page.goto(process.env.APP_URL ?? 'http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__store?.persist.hasHydrated());
  await page.evaluate(async () => {
    const { snapshotOf } = await import('/src/lib/transactions.ts');
    const nodes = Array.from({ length: 205 }, (_, index) => ({
      id: `n${index}`, type: 'thought', position: { x: index * 500, y: 0 },
      data: { question: `Boundary ${index}`, response: 'Retained details', responses: ['Retained details'],
        responseIndex: 0, editMode: 'manual', isLoading: false, isCollapsed: true,
        isEditing: false, isEditingResponse: false, highlights: [], attachments: [],
        excludedAttachmentIds: [], includedAttachmentIds: [], tokenCount: 0, highlightMode: 'off', roleMode: 'inherit' },
    }));
    const graph = { nodes, edges: [], organizationRelations: [], taxonomy: { tags: [], nodeTypes: [] } };
    window.__store.setState({ ...graph, history: [snapshotOf(graph)], historyIndex: 0, transactions: [], undoableTransactionIds: [], redoableTransactionIds: [], revision: 0 });
  });
  const overlay = page.locator('[data-knowledge-views]');
  await test('A2.B1 cards initially bounded to 100 and hide quick-note details', async () => {
    await view('card');
    await overlay.locator('[data-knowledge-node-id]').first().waitFor();
    assert.equal(await overlay.locator('[data-knowledge-node-id]').count(), 100);
    assert.equal(await overlay.getByText('Retained details', { exact: true }).count(), 0);
  });
  await test('A2.B2 card pagination handles final partial page', async () => {
    await overlay.getByRole('button', { name: 'Show more', exact: true }).click();
    assert.equal(await overlay.locator('[data-knowledge-node-id]').count(), 200);
    await overlay.getByRole('button', { name: 'Show more', exact: true }).click();
    assert.equal(await overlay.locator('[data-knowledge-node-id]').count(), 205);
    assert.equal(await overlay.getByRole('button', { name: 'Show more', exact: true }).count(), 0);
  });
  await test('A2.B3 tree roots are paged', async () => {
    await view('tree');
    await page.waitForFunction(() => document.querySelectorAll('[role=treeitem]').length === 100);
    await overlay.getByRole('button', { name: 'Show more', exact: true }).click();
    assert.equal(await overlay.getByRole('treeitem').count(), 200);
  });
  await test('A2.B4 child branches default collapsed and expand on demand', async () => {
    await view('canvas');
    await page.evaluate(() => window.__store.setState({
      organizationRelations: [{ id: 'parent', kind: 'parent', sourceId: 'n0', targetId: 'n1' }],
    }));
    await view('tree');
    assert.equal(await overlay.locator('[data-knowledge-node-id=n1]').count(), 0);
    await overlay.getByRole('button', { name: 'Expand', exact: true }).first().click();
    assert.equal(await overlay.locator('[data-knowledge-node-id=n1]').count(), 1);
    await overlay.getByRole('button', { name: 'Collapse', exact: true }).first().click();
    assert.equal(await overlay.locator('[data-knowledge-node-id=n1]').count(), 0);
  });
  await test('A2.B5 search shares filtering with cards and bounds its results', async () => {
    await view('card');
    await page.keyboard.press('Control+f');
    const input = page.getByPlaceholder(/Search nodes/);
    await input.fill('Boundary');
    await page.waitForFunction(() => document.querySelectorAll('[data-search-hit-row]').length === 50);
    await page.locator('ul').filter({ has: page.locator('[data-search-hit-row]') }).getByRole('button', { name: 'Show more', exact: true }).click();
    assert.equal(await page.locator('[data-search-hit-row]').count(), 100);
    await input.fill('Boundary 204');
    await page.waitForFunction(() => document.querySelectorAll('[data-search-hit-row]').length === 1);
    assert.equal(await overlay.locator('[data-knowledge-node-id]').count(), 1);
    await input.fill('no-such-node');
    await overlay.getByText('No nodes match the current filters', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-search-hit-row]').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await input.count(), 0);
  });
  await view('canvas');
  await page.evaluate(async () => {
    (await import('/src/lib/ui-store.ts')).useUiStore.setState({ knowledgeQuery: {} });
  });
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  for (const tag of ['input', 'textarea', 'contenteditable']) {
    await test(`D5.B1 ${tag} retains native Undo and Redo`, async () => {
      await page.evaluate(tag => {
        const field = document.createElement(tag === 'contenteditable' ? 'div' : tag);
        if (tag === 'contenteditable') field.contentEditable = 'true';
        field.setAttribute('data-native-editor', '');
        Object.assign(field.style, { position: 'fixed', top: '10px', left: '10px', width: '300px', height: '50px', zIndex: '99999', background: 'white' });
        document.body.append(field);
      }, tag);
      const editor = page.locator('[data-native-editor]');
      // Settle fixture edits before measuring whether native Undo touches the graph.
      const revision = await page.evaluate(async () => {
        (await import('/src/store/index.ts')).flushPendingTransaction('test.fixture');
        return window.__store.getState().revision;
      });
      await editor.click(); await page.keyboard.type('native draft');
      const value = () => editor.evaluate(el => el.isContentEditable ? el.textContent : el.value);
      assert.equal(await value(), 'native draft');
      await page.keyboard.press(`${modifier}+z`);
      assert.notEqual(await value(), 'native draft');
      await page.keyboard.press(`${modifier}+Shift+z`);
      assert.equal(await value(), 'native draft');
      assert.equal(await page.evaluate(() => window.__store.getState().revision), revision);
      await editor.evaluate(el => el.remove());
    });
  }
  await test('D5.B2 canvas Undo and shifted Redo still operate on graph', async () => {
    await page.evaluate(() => {
      const store = window.__store;
      store.getState().pushHistory();
      store.setState(s => ({ nodes: s.nodes.map(n => n.id === 'n0' ? { ...n, data: { ...n.data, question: 'changed by graph' } } : n) }));
      store.getState().pushHistory(); document.activeElement?.blur();
    });
    await page.keyboard.press(`${modifier}+z`);
    assert.equal(await page.evaluate(() => window.__store.getState().nodes[0].data.question), 'Boundary 0');
    await page.keyboard.press(`${modifier}+Shift+z`);
    assert.equal(await page.evaluate(() => window.__store.getState().nodes[0].data.question), 'changed by graph');
  });
  await test('D5.B3 switching projects clears stale filters in the card view', async () => {
    await view('card');
    await page.evaluate(async () => {
      const ui = (await import('/src/lib/ui-store.ts')).useUiStore;
      ui.setState({ knowledgeQuery: { text: 'missing' } });
      const { createProject } = await import('/src/store/projects.ts');
      await createProject('Other canvas');
      window.__store.getState().addQuestion('Other project node');
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-knowledge-views] [data-knowledge-node-id]').length === 1);
    await overlay.getByText('Other project node', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(async () => (await import('/src/lib/ui-store.ts')).useUiStore.getState().knowledgeQuery), {});
  });
  await test('A3.B1 version controls restore matching sources and survive reload', async () => {
    await view('canvas');
    await page.evaluate(async () => {
      const { withResponseVersions } = await import('/src/lib/response-versions.ts');
      const versions = ['one', 'two'].map(id => ({ id, question: `Question ${id}`, response: `Answer ${id}`, author: 'model',
        model: 'test', contextHash: `hash-${id}`, references: [{ title: `Source ${id}`, url: `https://example.com/${id}` }] }));
      window.__store.setState(s => ({ nodes: s.nodes.map(n => ({ ...n,
        data: withResponseVersions({ ...n.data, editMode: 'ai', isCollapsed: false, isEditing: false, isEditingResponse: false }, versions, 1) })) }));
    });
    const card = page.locator('.thought-node');
    await card.getByRole('button', { name: 'Previous version', exact: true }).click();
    await card.getByRole('link', { name: /Source one/ }).waitFor();
    assert.equal(await card.getByRole('link', { name: /Source two/ }).count(), 0);
    assert.equal(await page.evaluate(() => window.__store.getState().nodes[0].data.lastContextHash), 'hash-one');
    await page.evaluate(async () => (await import('/src/lib/persistence.ts')).flushPendingWrites());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__store?.persist.hasHydrated());
    assert.equal(await page.evaluate(() => window.__store.getState().nodes[0].data.references[0].title), 'Source one');
    await page.waitForFunction(() => !!window.__rf);
    await page.evaluate(() => window.__rf.setViewport({ x: 0, y: 0, zoom: 1 }));
    await card.getByRole('link', { name: /Source one/ }).waitFor();
    await card.getByRole('button', { name: 'Next version', exact: true }).click();
    await card.getByRole('link', { name: /Source two/ }).waitFor();
    assert.equal(await page.evaluate(() => window.__store.getState().nodes[0].data.responseVersions[1].id), 'two');
  });
  await test('tags can be selected, created inline and removed without deleting definitions', async () => {
    await page.evaluate(async () => {
      const store = window.__store;
      const tagId = store.getState().createTag('Existing tag');
      store.getState().setNodeTag([store.getState().nodes[0].id], tagId, true);
      const ui = (await import('/src/lib/ui-store.ts')).useUiStore;
      ui.getState().setMetadataEditorNodeIds([store.getState().nodes[0].id]);
    });
    const dialog = page.locator('[data-metadata-dialog]');
    const input = dialog.getByRole('textbox', { name: 'Search or create tags…' });
    await input.fill('New tag');
    await dialog.getByRole('button', { name: 'Create and select “New tag”', exact: true }).click();
    assert.equal(await input.inputValue(), '');
    assert.equal(await dialog.locator('[data-selected-tags] button').count(), 2);
    await dialog.getByRole('button', { name: 'Remove tag “New tag”', exact: true }).click();
    assert.equal(await dialog.locator('[data-selected-tags] button').count(), 1);
    await input.fill('  NEW   tag  ');
    assert.equal(await dialog.getByRole('button', { name: /Create and select/ }).count(), 0);
    await input.press('Enter');
    assert.equal(await dialog.locator('[data-selected-tags] button').count(), 2);
    assert.equal(await page.evaluate(() => window.__store.getState().taxonomy.tags.filter(t => t.name === 'New tag').length), 1);
    await dialog.getByRole('button', { name: 'Existing tag', exact: true }).click();
    assert.equal(await dialog.locator('[data-selected-tags] button').count(), 1);
    await page.evaluate(async () => (await import('/src/lib/ui-store.ts')).useUiStore.getState().setMetadataEditorNodeIds(null));
  });
  await test('tag multiselect ignores empty/IME input and supports batch assignment', async () => {
    await page.evaluate(async () => {
      const store = window.__store;
      store.getState().addQuestion('Tag search control');
      const ui = (await import('/src/lib/ui-store.ts')).useUiStore;
      ui.getState().setMetadataEditorNodeIds(store.getState().nodes.map(n => n.id));
    });
    const dialog = page.locator('[data-metadata-dialog]');
    const input = dialog.getByRole('textbox', { name: 'Search or create tags…' });
    const count = await page.evaluate(() => window.__store.getState().taxonomy.tags.length);
    await input.fill('   '); await input.press('Enter');
    assert.equal(await page.evaluate(() => window.__store.getState().taxonomy.tags.length), count);
    await input.fill('中文标签');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.equal(await page.evaluate(() => window.__store.getState().taxonomy.tags.length), count);
    await input.press('Enter');
    assert.ok(await page.evaluate(() => {
      const s = window.__store.getState(); const tag = s.taxonomy.tags.find(t => t.name === '中文标签');
      return s.nodes.every(n => n.data.tagIds?.includes(tag.id));
    }));
    await dialog.getByRole('button', { name: 'Remove tag “中文标签”', exact: true }).click();
    assert.ok(await page.evaluate(() => {
      const s = window.__store.getState(); const tag = s.taxonomy.tags.find(t => t.name === '中文标签');
      return tag && s.nodes.every(n => !n.data.tagIds?.includes(tag.id));
    }));
    await page.evaluate(async () => (await import('/src/lib/ui-store.ts')).useUiStore.getState().setMetadataEditorNodeIds(null));
  });
  await test('tag search highlights only matches even with a different focused node', async () => {
    await page.evaluate(async () => {
      const s = window.__store.getState();
      s.setSelectedNodeId(s.nodes[1].id);
      const ui = (await import('/src/lib/ui-store.ts')).useUiStore;
      ui.setState({ activeNodeId: s.nodes[1].id, knowledgeQuery: {}, localDepth: 0 });
      window.__rf.setViewport({ x: 0, y: 0, zoom: 1 });
    });
    await page.keyboard.press('Control+f');
    const search = page.locator('[data-canvas-search]');
    assert.equal(await search.getByRole('combobox', { name: 'Search mode' }).count(), 0);
    await search.getByRole('button', { name: 'New tag', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node.search-hit').length === 1);
    await page.waitForFunction(() => [...document.querySelectorAll('.react-flow__node')].every(el =>
      Number(getComputedStyle(el).opacity) === (el.classList.contains('search-hit') ? 1 : 0.16)));
    assert.equal(await search.locator('[data-search-hit-row]').count(), 1);
    await view('card');
    assert.equal(await overlay.locator('[data-knowledge-node-id]').count(), 1);
    await search.getByRole('textbox', { name: /Search nodes/ }).fill('missing text');
    await page.waitForFunction(() => document.querySelectorAll('[data-search-hit-row]').length === 0);
    assert.equal(await overlay.locator('[data-knowledge-node-id]').count(), 0);
    await search.getByRole('button', { name: 'New tag', exact: true }).click();
    await search.getByRole('textbox', { name: /Search nodes/ }).fill('Tag search control');
    await page.waitForFunction(() => document.querySelectorAll('[data-search-hit-row]').length === 1);
    await page.keyboard.press('Escape');
    await page.evaluate(async () => (await import('/src/lib/ui-store.ts')).useUiStore.setState({ knowledgeQuery: {} }));
  });
  await test('tag assignments persist through reload', async () => {
    const before = await page.evaluate(() => ({ tags: window.__store.getState().taxonomy.tags, assignments: window.__store.getState().nodes.map(n => [n.id, n.data.tagIds ?? []]) }));
    await page.evaluate(async () => (await import('/src/lib/persistence.ts')).flushPendingWrites());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__store?.persist.hasHydrated());
    assert.deepEqual(await page.evaluate(() => ({ tags: window.__store.getState().taxonomy.tags, assignments: window.__store.getState().nodes.map(n => [n.id, n.data.tagIds ?? []]) })), before);
  });
  await test('canvas tags sit below content and wrap without truncation', async () => {
    await view('canvas');
    await page.evaluate(async () => {
      const s = window.__store.getState();
      const names = ['基础概念', '生产者', '可靠性', '面试追问', '很长的标签名称'.repeat(12)];
      const tagIds = names.map(name => s.createTag(name));
      const base = s.nodes[0];
      window.__store.setState({ nodes: [
        { ...base, id: 'footer-thought', position: { x: 0, y: 0 }, data: { ...base.data, editMode: 'manual-detail', isCollapsed: false, tagIds } },
        { ...base, id: 'footer-note', type: 'thought', position: { x: 600, y: 0 }, data: { ...base.data, stepKind: 'note', editMode: 'manual', tagIds } },
      ], edges: [] });
      (await import('/src/lib/ui-store.ts')).useUiStore.setState({ knowledgeQuery: {}, localDepth: 0 });
      window.__rf.setViewport({ x: 0, y: 0, zoom: 1 });
    });
    for (const id of ['footer-thought', 'footer-note']) {
      const node = page.locator(`.react-flow__node[data-id="${id}"]`);
      const footer = node.locator('[data-taxonomy-footer]');
      await footer.waitFor();
      assert.equal(await footer.locator('> span').count(), 5);
      assert(await footer.evaluate(el => {
        const header = el.parentElement.querySelector('.drag-handle');
        return el.getBoundingClientRect().top >= header.getBoundingClientRect().bottom &&
          getComputedStyle(el).flexWrap === 'wrap' && [...el.children].every(ch =>
            getComputedStyle(ch).textOverflow !== 'ellipsis' && ch.scrollWidth <= ch.clientWidth + 1);
      }));
      assert.equal(await node.locator('.drag-handle [data-node-taxonomy]').count(), 0);
    }
  });
  await test('spacing button lays out measured cards and repeated clicks stay stable', async () => {
    await page.evaluate(() => {
      const base = window.__store.getState().nodes[0];
      window.__store.setState({ nodes: ['spacing-root', 'spacing-child', 'spacing-sibling'].map((id, i) => ({
        ...base, id, position: { x: i * 20, y: i * 20 }, measured: undefined,
        data: { ...base.data, stepKind: undefined, isCollapsed: true, editMode: 'manual-detail' },
      })), edges: [
        { id: 'spacing-1', source: 'spacing-root', target: 'spacing-child' },
        { id: 'spacing-2', source: 'spacing-root', target: 'spacing-sibling' },
      ], organizationRelations: [] });
      window.__rf.setViewport({ x: 0, y: 0, zoom: 0.5 });
    });
    await page.waitForFunction(() => window.__store.getState().nodes.every(n => n.measured?.height > 0));
    const button = page.getByRole('button', { name: 'Adjust node spacing', exact: true });
    await button.click();
    const positions = () => page.evaluate(() => window.__store.getState().nodes.map(n => ({ id: n.id, ...n.position, height: n.measured.height })));
    assert.equal(await page.evaluate(() => window.__rf.getZoom()), 0.5);
    const coordinates = await page.evaluate(() => window.__store.getState().nodes.map(n => n.position));
    assert(await page.evaluate(() => window.__store.getState().nodes.every(n => n.data.isCollapsed)));
    await page.evaluate(() => window.__store.getState().nodes.forEach(n => window.__store.getState().toggleCollapse(n.id)));

    await page.evaluate(() => window.__rf.setViewport({ x: 0, y: 0, zoom: 1.5 }));
    await page.waitForFunction(() => !document.querySelector('.react-flow__node [data-map-tool-marks]') &&
      document.querySelectorAll('.react-flow__node [data-taxonomy-footer]').length > 0);
    await page.waitForTimeout(150);
    const once = await positions();
    assert.deepEqual(once.map(({ x, y }) => ({ x, y })), coordinates);
    assert.equal(once[0].x, once[1].x);
    assert(once[1].y >= once[0].y + once[0].height + 72);
    assert(once[2].x > once[1].x);
    await button.click();
    await button.click();
    assert.deepEqual((await positions()).map(({ x, y }) => ({ x, y })), coordinates);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.__store.getState().toggleCollapse('spacing-root'));
      assert.deepEqual((await positions()).map(({ x, y }) => ({ x, y })), coordinates);
    }

  });
  assert.deepEqual(errors, [], 'browser must have no runtime/console errors');
  console.log(`${passed}/${passed} browser boundary groups passed`);
} finally { await browser.close(); }
