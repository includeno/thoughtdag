// electron-builder unconditionally strips node_modules out of
// extraResources copies (hardcoded, filter patterns can't override it),
// which shipped v0.3.0 with a payload that couldn't import express.
// This hook runs after packing and BEFORE signing, so the modules it
// copies in are covered by the signature and the notarization seal.
const { cpSync, existsSync } = require('node:fs');
const path = require('node:path');

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
