// electron-builder unconditionally strips node_modules out of
// extraResources copies (hardcoded, filter patterns can't override it),
// which shipped v0.3.0 with a payload that couldn't import express.
// This hook runs after packing and BEFORE signing, so the modules it
// copies in are covered by the signature and the notarization seal.
const { cpSync, existsSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { extractFile } = require('@electron/asar');
const vm = require('node:vm');

module.exports = async function afterPack(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : path.join(context.appOutDir, 'resources');
  const archive = path.join(resources, 'app.asar');
  const manifest = JSON.parse(extractFile(archive, 'package.json').toString());
  // Execute the real packaged startup configuration with a disposable app stub.
  const paths = {};
  const app = {
    getPath: name => paths[name] ?? resources,
    setPath: (name, value) => { paths[name] = value; },
  };
  const startup = extractFile(archive, 'main.js').toString().split('const ROOT =')[0];
  vm.runInNewContext(startup, {
    require: name => name === 'electron' ? { app } : name === './package.json' ? manifest : require(name),
    process: { argv: [`--user-data-dir=${path.join(resources, 'test-profile')}`] },
  });
  assert.equal(paths.userData, path.join(resources, 'test-profile'));
  assert.equal(paths.sessionData, paths.userData);
  cpSync(
    path.join(__dirname, '..', 'payload', 'node_modules'),
    path.join(resources, 'payload', 'node_modules'),
    { recursive: true },
  );
  const required = [
    'payload/server.mjs',
    'payload/scripts/thoughtdag-cli.mjs',
    'payload/shared/cli-commands.mjs',
    'payload/shared/cli-control-plane.mjs',
    'payload/dist/index.html',
    'payload/node_modules/express/package.json',
  ];
  const missing = required.filter((relative) => !existsSync(path.join(resources, relative)));
  if (missing.length > 0) {
    throw new Error(`afterPack: packaged runtime is incomplete:\n${missing.join('\n')}`);
  }
  console.log('afterPack: payload restored and verified in', resources);
};
