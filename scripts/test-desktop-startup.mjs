import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../desktop/', import.meta.url));
const require = createRequire(path.join(desktop, 'package.json'));
const { createTransformer } = require('app-builder-lib/out/fileTransformer.js');
const packageFile = path.join(desktop, 'package.json');
const manifest = JSON.parse(await createTransformer(desktop, {}, {})(packageFile));
assert.equal(manifest.build, undefined, 'use the actual builder transformation, not a simulated manifest');
const startup = (await readFile(path.join(desktop, 'main.js'), 'utf8')).split('const ROOT =')[0];
for (const profile of [null, path.join(desktop, 'test profile with spaces')]) {
  const paths = { userData: '/existing/profile', sessionData: '/existing/profile' };
  vm.runInNewContext(startup, {
    require: name => name === 'electron' ? { app: {
      getPath: name => paths[name], setPath: (name, value) => { paths[name] = value; },
    } } : name === './package.json' ? manifest : require(name),
    process: { argv: profile ? [`--user-data-dir=${profile}`] : [] },
  });
  assert.equal(paths.userData, profile ?? '/existing/profile');
  assert.equal(paths.sessionData, paths.userData);
}
console.log('PASS packaged startup without build metadata; default profile preserved; explicit profile with spaces');
