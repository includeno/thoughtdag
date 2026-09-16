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
      const revision = await page.evaluate(() => window.__store.getState().revision);
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
  assert.deepEqual(errors, [], 'browser must have no runtime/console errors');
  console.log(`${passed}/${passed} browser boundary groups passed`);
} finally { await browser.close(); }
