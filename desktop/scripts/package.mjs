#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(desktop);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const builder = path.join(
  desktop,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);

const HOST_PLATFORM = {
  darwin: 'mac',
  win32: 'win',
  linux: 'linux',
}[process.platform];

const PLATFORM_FLAGS = { mac: '--mac', win: '--win', linux: '--linux' };
const DEFAULT_TARGETS = { mac: ['dmg', 'zip'], win: ['nsis'], linux: ['AppImage'] };
const TARGETS = {
  mac: new Map([['dmg', 'dmg'], ['zip', 'zip'], ['pkg', 'pkg']]),
  win: new Map([['nsis', 'nsis'], ['portable', 'portable'], ['zip', 'zip']]),
  linux: new Map([
    ['appimage', 'AppImage'], ['deb', 'deb'], ['rpm', 'rpm'],
    ['tar.gz', 'tar.gz'], ['zip', 'zip'],
  ]),
};
const ARCHES = new Set(['current', 'x64', 'arm64', 'universal', 'all']);

function fail(message) {
  process.stderr.write(`ThoughtDAG package: ${message}\n`);
  process.exit(1);
}

function usage() {
  return `ThoughtDAG desktop packager

Usage:
  node desktop/scripts/package.mjs [options]

Options:
  --platform <auto|mac|win|linux>   Default: current host
  --arch <current|x64|arm64|universal|all>
                                    Default: current host architecture
  --mode <installer|dir>            Installer(s) or unpacked directory
  --targets <a,b,...>                Override platform targets
  --sign <auto|never|required>       Default: auto
  --version <semver>                 Override packaged app version
  --install                          Run npm ci in root and desktop first
  --skip-build                       Reuse root dist/
  --skip-payload                     Reuse desktop/payload/
  --clean                            Remove desktop/out before packaging
  --allow-cross                      Permit non-native host attempts
  --dry-run                          Print commands without changing files
  --help

Examples:
  npm run desktop:package -- --mode dir --sign never
  npm run desktop:package -- --platform mac --arch arm64 --sign never
  npm run desktop:package -- --platform mac --arch all --sign required
  npm run desktop:package -- --platform win --arch x64
  npm run desktop:package -- --platform linux --arch arm64 --targets AppImage,deb
`;
}

const raw = process.argv.slice(2);
const options = {
  platform: 'auto',
  arch: 'current',
  mode: 'installer',
  targets: undefined,
  sign: 'auto',
  version: undefined,
  install: false,
  skipBuild: false,
  skipPayload: false,
  clean: false,
  allowCross: false,
  dryRun: false,
};

function takeValue(index, name) {
  const token = raw[index];
  const equals = token.indexOf('=');
  if (equals !== -1) return { value: token.slice(equals + 1), consumed: 1 };
  if (raw[index + 1] === undefined) fail(`${name} requires a value`);
  return { value: raw[index + 1], consumed: 2 };
}

for (let index = 0; index < raw.length;) {
  const token = raw[index];
  const name = token.split('=', 1)[0];
  if (name === '--help' || name === '-h') {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (['--install', '--skip-build', '--skip-payload', '--clean', '--allow-cross', '--dry-run'].includes(name)) {
    const key = {
      '--install': 'install', '--skip-build': 'skipBuild', '--skip-payload': 'skipPayload',
      '--clean': 'clean', '--allow-cross': 'allowCross', '--dry-run': 'dryRun',
    }[name];
    options[key] = true;
    index += 1;
    continue;
  }
  const keys = {
    '--platform': 'platform', '--arch': 'arch', '--mode': 'mode', '--targets': 'targets',
    '--target': 'targets', '--sign': 'sign', '--version': 'version',
  };
  const key = keys[name];
  if (!key) fail(`unknown option: ${token}`);
  const { value, consumed } = takeValue(index, name);
  options[key] = value;
  index += consumed;
}

const platform = options.platform === 'auto' ? HOST_PLATFORM : options.platform;
if (!platform || !PLATFORM_FLAGS[platform]) fail(`unsupported platform: ${options.platform}`);
if (!ARCHES.has(options.arch)) fail(`unsupported architecture: ${options.arch}`);
if (!['installer', 'dir'].includes(options.mode)) fail(`unsupported mode: ${options.mode}`);
if (!['auto', 'never', 'required'].includes(options.sign)) fail(`unsupported signing mode: ${options.sign}`);
if (options.arch === 'universal' && platform !== 'mac') fail('universal architecture is supported only for macOS');

if (platform !== HOST_PLATFORM && !options.allowCross && !options.dryRun) {
  fail(`building ${platform} on ${HOST_PLATFORM ?? process.platform} is disabled; use that platform's runner or pass --allow-cross`);
}

const archList = options.arch === 'all'
  ? platform === 'mac' ? ['arm64', 'x64'] : ['x64', 'arm64']
  : options.arch === 'current'
    ? [process.arch]
    : [options.arch];
for (const arch of archList) {
  if (!['x64', 'arm64', 'universal'].includes(arch)) {
    fail(`current host architecture ${arch} is not supported; pass --arch x64 or --arch arm64`);
  }
}

let targets = options.targets
  ? String(options.targets).split(',').map((value) => value.trim()).filter(Boolean)
  : DEFAULT_TARGETS[platform];
targets = targets.map((target) => {
  const normalized = TARGETS[platform].get(target.toLowerCase());
  if (!normalized) fail(`unsupported ${platform} target: ${target}`);
  return normalized;
});

function normalizeVersion(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().replace(/^v(?=\d)/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized)) {
    fail(`invalid semantic version: ${value}`);
  }
  return normalized;
}

const inferredTagVersion = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
const version = normalizeVersion(options.version || process.env.THOUGHTDAG_DESKTOP_VERSION || inferredTagVersion);

function hasAppleIdCredentials(env) {
  return !!(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
}

function hasAppleApiCredentials(env) {
  return !!(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
}

function hasKeychainCredentials(env) {
  return !!env.APPLE_KEYCHAIN_PROFILE;
}

if (options.sign === 'required') {
  if (platform === 'mac') {
    if (!(process.env.CSC_LINK || process.env.CSC_NAME)) {
      fail('macOS signing requires CSC_LINK or CSC_NAME');
    }
    if (!(hasAppleIdCredentials(process.env) || hasAppleApiCredentials(process.env) || hasKeychainCredentials(process.env))) {
      fail('macOS notarization requires the Apple ID trio, API key trio, or APPLE_KEYCHAIN_PROFILE');
    }
  } else if (platform === 'win' && !(process.env.WIN_CSC_LINK || process.env.CSC_LINK)) {
    fail('Windows signing requires WIN_CSC_LINK or CSC_LINK');
  } else if (platform === 'linux') {
    fail('--sign required is not defined for Linux artifacts; use --sign auto or --sign never');
  }
}

function quote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=+,-]+$/.test(text) ? text : JSON.stringify(text);
}

function run(command, args, cwd, env = process.env) {
  process.stdout.write(`\n> (${path.relative(root, cwd) || '.'}) ${[command, ...args].map(quote).join(' ')}\n`);
  if (options.dryRun) return;
  const outcome = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (outcome.error) fail(outcome.error.message);
  if (outcome.status !== 0) process.exit(outcome.status ?? 1);
}

if (platform !== HOST_PLATFORM && options.dryRun) {
  process.stdout.write(`dry-run note: an actual ${platform} build should run on a ${platform} host or use --allow-cross with the required external tooling.\n`);
}

if (options.install) {
  run(npmCommand, ['ci'], root);
  run(npmCommand, ['ci'], desktop);
}

if (!options.skipBuild) {
  run(npmCommand, ['run', 'build'], root);
} else if (!options.dryRun && !existsSync(path.join(root, 'dist', 'index.html'))) {
  fail('--skip-build requested but dist/index.html is missing');
}

if (!options.skipPayload) {
  run(npmCommand, ['run', 'payload'], desktop);
} else if (!options.dryRun && !existsSync(path.join(desktop, 'payload', 'server.mjs'))) {
  fail('--skip-payload requested but desktop/payload/server.mjs is missing');
}

if (options.clean) {
  process.stdout.write(`\n> remove ${path.relative(root, path.join(desktop, 'out'))}\n`);
  if (!options.dryRun) rmSync(path.join(desktop, 'out'), { recursive: true, force: true });
}

if (!options.dryRun && !existsSync(builder)) {
  fail('electron-builder is not installed under desktop/node_modules; rerun with --install or run npm ci in desktop');
}

const builderArgs = [PLATFORM_FLAGS[platform]];
if (options.mode === 'dir') builderArgs.push('--dir');
else builderArgs.push(...targets);
for (const arch of archList) builderArgs.push(`--${arch}`);
builderArgs.push('--publish', 'never');
if (version) builderArgs.push(`--config.extraMetadata.version=${version}`);
if (options.sign === 'never' && platform === 'mac') builderArgs.push('--config.mac.notarize=false');

const builderEnv = { ...process.env };
if (options.sign === 'never') {
  builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) {
    delete builderEnv[name];
  }
}

process.stdout.write([
  '',
  `Packaging plan: platform=${platform} arch=${archList.join(',')} mode=${options.mode}`,
  `targets=${options.mode === 'dir' ? '(unpacked)' : targets.join(',')} sign=${options.sign}`,
  `version=${version ?? '(desktop/package.json)'}`,
].join('\n') + '\n');

run(builder, builderArgs, desktop, builderEnv);

if (!options.dryRun) {
  process.stdout.write(`\nDesktop artifacts are in ${path.join(desktop, 'out')}\n`);
}
