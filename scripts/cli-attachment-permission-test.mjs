#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'vite';

// Load the real browser modules through Vite's SSR transformer. Viewer mode
// gives the Zustand store a no-op persistence backend, so this test never
// touches a developer's IndexedDB while still exercising the production
// ingestFiles callbacks and paradigm cascade.
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.location = {
  hostname: 'localhost',
  protocol: 'http:',
  hash: '#view=cli-permission-test',
  href: 'http://localhost:5173/#view=cli-permission-test',
  origin: 'http://localhost:5173',
};
globalThis.window = { location: globalThis.location, addEventListener: () => {} };
globalThis.document = { visibilityState: 'visible', addEventListener: () => {} };
globalThis.FileReader = class FileReader {
  result = null;
  onload = null;
  onerror = null;

  readAsDataURL(file) {
    void file.arrayBuffer().then((bytes) => {
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString('base64')}`;
      this.onload?.();
    }).catch(() => this.onerror?.());
  }
};

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const [{ ingestFiles, buildContentNode }, { useStore }] = await Promise.all([
    vite.ssrLoadModule('/src/lib/content.ts'),
    vite.ssrLoadModule('/src/store/index.ts'),
  ]);

  let generations = 0;
  function seedGraph(prefix) {
    const material = { ...buildContentNode('file', { x: 0, y: 0 }), id: `${prefix}-material` };
    const promptBase = buildContentNode('note', { x: 0, y: 160 });
    const prompt = {
      ...promptBase,
      id: `${prefix}-prompt`,
      data: { ...promptBase.data, stepKind: 'prompt' },
    };
    useStore.setState({
      nodes: [material, prompt],
      edges: [{ id: `${prefix}-edge`, source: material.id, target: prompt.id, data: {} }],
      rerunNode: async () => { generations++; },
    });
    return material.id;
  }

  const restrictedId = seedGraph('restricted');
  await ingestFiles(
    restrictedId,
    [new File(['plain text'], 'restricted.txt', { type: 'text/plain' })],
    { allowGenerativeProcessing: false },
  );
  assert.equal(useStore.getState().nodes[0].data.attachments.length, 1, 'restricted CLI upload still stores the file');
  assert.equal(generations, 0, 'restricted CLI upload must not trigger a paradigm generation');

  let modelRequests = 0;
  globalThis.fetch = async () => {
    modelRequests++;
    return new Response(JSON.stringify({ models: [], default: null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const restrictedImageId = seedGraph('restricted-image');
  await ingestFiles(
    restrictedImageId,
    [new File([new Uint8Array([1, 2, 3])], 'restricted.png', { type: 'image/png' })],
    { allowGenerativeProcessing: false },
  );
  assert.equal(modelRequests, 0, 'restricted CLI image upload must not start model extraction');
  assert.equal(generations, 0, 'restricted CLI image upload must not trigger a paradigm generation');

  const defaultId = seedGraph('default');
  await ingestFiles(defaultId, [new File(['plain text'], 'default.txt', { type: 'text/plain' })]);
  assert.equal(generations, 1, 'the existing two-argument UI path keeps paradigm cascading enabled');

  const defaultImageId = seedGraph('default-image');
  await ingestFiles(
    defaultImageId,
    [new File([new Uint8Array([1, 2, 3])], 'default.png', { type: 'image/png' })],
  );
  assert.equal(modelRequests, 1, 'the existing two-argument UI path keeps image model extraction enabled');
  assert.equal(generations, 2, 'the existing two-argument UI image path keeps paradigm cascading enabled');

  console.log('CLI attachment permission tests passed');
} finally {
  await vite.close();
}
