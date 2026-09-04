#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CLI_COMMAND_GROUPS, CLI_COMMAND_IDS } from '../shared/cli-commands.mjs';

const argv = process.argv.slice(2);
let activeRequest = null;
let handlingSignal = false;

function reportFatal(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ThoughtDAG CLI: ${message}\n`);
  process.exit(1);
}

process.on('uncaughtException', reportFatal);
process.on('unhandledRejection', reportFatal);
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    if (handlingSignal) return;
    handlingSignal = true;
    void (async () => {
      if (activeRequest) {
        await request(activeRequest.session, `/api/cli/commands/${encodeURIComponent(activeRequest.id)}/cancel`, {
          method: 'POST', body: '{}',
        }, 2_000).catch(() => {});
      }
      process.exit(exitCode);
    })();
  });
}

function takeOption(name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  argv.splice(index, 2);
  return value;
}

const sessionOption = takeOption('--session');
const jsonOption = takeOption('--json');
const fileOption = takeOption('--file');
const nodeOption = takeOption('--node');
const outputOption = takeOption('--output');
const timeoutOption = takeOption('--timeout');
const command = argv.shift() || 'help';
if (argv.length > 0) throw new Error(`Unexpected arguments: ${argv.join(' ')}`);

function usage() {
  return `ThoughtDAG CLI

Usage:
  npm run cli -- status
  npm run cli -- groups
  npm run cli -- <command> --json '{"key":"value"}'
  npm run cli -- <command> --json @payload.json
  npm run cli -- <command> --json -

Convenience:
  npm run cli -- attachment.add --node <node-id> --file <path>
  npm run cli -- project.import --file <canvas.thoughtdag.json>
  npm run cli -- canvas.export --output <canvas.thoughtdag.json>

Options:
  --session <path>   Session file shown in ThoughtDAG CLI settings
  --timeout <ms>     Wait limit, default 600000
  --output <path>    Write the command result to a file

Run "groups" to list every permission group and command.`;
}

function parseJsonSource(source) {
  if (!source) return {};
  if (source === '-') return JSON.parse(fs.readFileSync(0, 'utf8'));
  if (source.startsWith('@')) return JSON.parse(fs.readFileSync(path.resolve(source.slice(1)), 'utf8'));
  return JSON.parse(source);
}

function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({
    '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
    '.html': 'text/html', '.htm': 'text/html', '.xml': 'text/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
    '.css': 'text/css', '.py': 'text/x-python', '.pdf': 'application/pdf', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  })[ext] || 'application/octet-stream';
}

function findSessionFile() {
  if (sessionOption) {
    if (!fs.existsSync(sessionOption)) throw new Error(`Session file not found: ${path.resolve(sessionOption)}`);
    return path.resolve(sessionOption);
  }
  const candidates = [process.env.THOUGHTDAG_CLI_SESSION, path.join(process.cwd(), '.thoughtdag-cli-session.json')].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('No CLI session file found. Start ThoughtDAG locally, then open Settings → CLI control.');
  }
  return path.resolve(found);
}

async function request(session, pathname, init = {}, requestTimeoutMs = 30_000) {
  const response = await fetch(`${session.url}${pathname}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function print(value) {
  if (typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (command === 'help' || command === '--help' || command === '-h') {
  print(usage());
  process.exit(0);
}

if (command === 'groups') {
  for (const group of CLI_COMMAND_GROUPS) {
    process.stdout.write(`${group.id}${group.danger ? ' [danger]' : ''}\n`);
    for (const id of group.commands) process.stdout.write(`  ${id}\n`);
  }
  process.exit(0);
}

const sessionPath = findSessionFile();
const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
if (session.version !== 1 || typeof session.url !== 'string' || typeof session.token !== 'string' || !session.token) {
  throw new Error(`Invalid or unsupported session file: ${sessionPath}`);
}
const sessionUrl = new URL(session.url);
if (sessionUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(sessionUrl.hostname)) {
  throw new Error(`Session URL must use the local loopback proxy: ${session.url}`);
}

if (command === 'status') {
  print(await request(session, '/api/cli/status'));
  process.exit(0);
}

if (!CLI_COMMAND_IDS.includes(command)) throw new Error(`Unknown command: ${command}. Run "groups" to list commands.`);

let args = parseJsonSource(jsonOption);
if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('--json must contain an object');

if (fileOption && command === 'attachment.add') {
  const filepath = path.resolve(fileOption);
  const content = fs.readFileSync(filepath);
  const type = mimeFor(filepath);
  const text = type.startsWith('text/') || ['application/json'].includes(type);
  args = {
    ...args,
    nodeId: nodeOption || args.nodeId,
    attachment: {
      name: path.basename(filepath),
      type,
      size: content.length,
      encoding: text ? 'utf8' : 'base64',
      content: content.toString(text ? 'utf8' : 'base64'),
    },
  };
}

if (fileOption && command === 'project.import') {
  args = { ...JSON.parse(fs.readFileSync(path.resolve(fileOption), 'utf8')), ...args };
}

if (fileOption && command !== 'attachment.add' && command !== 'project.import') {
  throw new Error('--file is supported by attachment.add and project.import');
}

const parsedTimeout = timeoutOption === undefined ? 600_000 : Number(timeoutOption);
if (!Number.isFinite(parsedTimeout) || parsedTimeout < 1_000 || parsedTimeout > 60 * 60_000) {
  throw new Error('--timeout must be between 1000 and 3600000ms');
}
const timeoutMs = parsedTimeout;
const accepted = await request(session, '/api/cli/commands', {
  method: 'POST',
  body: JSON.stringify({ command, args, timeoutMs }),
});
activeRequest = { session, id: accepted.id };
const deadline = Date.now() + timeoutMs;
let result;
while (Date.now() < deadline) {
  result = await request(session, `/api/cli/commands/${encodeURIComponent(accepted.id)}`);
  if (!result.pending) break;
  await new Promise((resolve) => setTimeout(resolve, 350));
}
if (!result || result.pending) {
  await request(session, `/api/cli/commands/${encodeURIComponent(accepted.id)}/cancel`, {
    method: 'POST',
    body: '{}',
  }, 5_000).catch(() => {});
  throw new Error(`Command timed out and cancellation was requested after ${timeoutMs}ms`);
}
activeRequest = null;
if (!result.ok) throw new Error(result.error || 'Command failed');

if (outputOption) {
  const serialized = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2);
  fs.writeFileSync(path.resolve(outputOption), serialized);
  print({ ok: true, output: path.resolve(outputOption) });
} else {
  print(result.result ?? { ok: true });
}
