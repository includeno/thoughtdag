// Assemble the self-contained runtime the packaged app ships with:
// server.mjs + built dist + the server's OWN production node_modules.
// The root dependencies are dominated by frontend libraries (react,
// canvas, markdown) the server never imports — installing them all
// ballooned the payload to 220MB and dragged native .node binaries in
// (a notarization hazard). So the payload gets a minimal package.json
// holding exactly what server.mjs imports, and installs that.
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(desktop);
const payload = path.join(desktop, 'payload');

// Every non-node: import at the top of server.mjs, nothing else.
// zod rides into the root tree as a transitive dep, so its version is
// read from the installed copy when package.json doesn't pin it.
const SERVER_DEPS = [
  'express',
  'cors',
  'ai',
  'zod',
  'zhipu-ai-provider',
  '@ai-sdk/openai-compatible',
  '@ai-sdk/mcp',
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/deepseek',
  'pdfjs-dist',
];

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('dist/ missing — run `npm run build` at the repo root first.');
  process.exit(1);
}

const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const dependencies = {};
for (const name of SERVER_DEPS) {
  const declared = rootPkg.dependencies?.[name];
  if (declared) {
    dependencies[name] = declared;
  } else {
    const installed = JSON.parse(
      readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
    );
    dependencies[name] = `^${installed.version}`;
  }
}

rmSync(payload, { recursive: true, force: true });
mkdirSync(payload, { recursive: true });
cpSync(path.join(root, 'server.mjs'), path.join(payload, 'server.mjs'));
// the one-command handoff files the app can install into agents
mkdirSync(path.join(payload, 'commands'), { recursive: true });
cpSync(path.join(root, 'protocol', 'adapters', 'claude-code', 'thoughtdag.md'), path.join(payload, 'commands', 'claude-code-thoughtdag.md'));
cpSync(path.join(root, 'protocol', 'adapters', 'codex', 'skills', 'thoughtdag', 'SKILL.md'), path.join(payload, 'commands', 'codex-thoughtdag-SKILL.md'));
mkdirSync(path.join(payload, 'scripts'), { recursive: true });
cpSync(path.join(root, 'scripts', 'thoughtdag-cli.mjs'), path.join(payload, 'scripts', 'thoughtdag-cli.mjs'));
mkdirSync(path.join(payload, 'shared'), { recursive: true });
cpSync(path.join(root, 'shared', 'cli-commands.mjs'), path.join(payload, 'shared', 'cli-commands.mjs'));
cpSync(path.join(root, 'shared', 'cli-control-plane.mjs'), path.join(payload, 'shared', 'cli-control-plane.mjs'));
cpSync(path.join(root, 'dist'), path.join(payload, 'dist'), { recursive: true });
writeFileSync(
  path.join(payload, 'package.json'),
  JSON.stringify({ name: 'thoughtdag-server-payload', private: true, dependencies }, null, 2),
);

console.log('installing server dependencies…');
// --omit=optional keeps native optional deps out (fsevents, pdfjs's
// canvas backend) — text extraction works without them, and Resources
// must stay free of unsigned Mach-O binaries for notarization.
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(
  npmCommand,
  ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: payload, stdio: 'inherit' },
);
if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status ?? 1);

const findNativeBinaries = (dir, found = []) => {
  if (found.length >= 5) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filepath = path.join(dir, entry.name);
    if (entry.isDirectory()) findNativeBinaries(filepath, found);
    else if (entry.isFile() && entry.name.endsWith('.node')) found.push(filepath);
    if (found.length >= 5) break;
  }
  return found;
};
const nativeBinaries = findNativeBinaries(path.join(payload, 'node_modules'));
if (nativeBinaries.length > 0) {
  console.error('native binaries slipped into the payload:\n' + nativeBinaries.join('\n'));
  process.exit(1);
}

// codesign --strict rejects any symlink that leaves the bundle. npm's
// .bin shims are launchers the server never spawns — drop them — and
// absolute or dangling links (npm sometimes writes absolute ones) would
// point outside the .app, so they must not survive either. Plain fs
// walking, because this also runs on the Windows builder.
const pruneUnsafe = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      let ok = !path.isAbsolute(readlinkSync(fp));
      if (ok) { try { statSync(fp); } catch { ok = false; } }
      if (!ok) { rmSync(fp); console.log('pruned unsafe symlink:', fp); }
    } else if (e.isDirectory()) {
      if (e.name === '.bin') rmSync(fp, { recursive: true, force: true });
      else pruneUnsafe(fp);
    }
  }
};
pruneUnsafe(path.join(payload, 'node_modules'));
console.log('payload ready:', payload);
