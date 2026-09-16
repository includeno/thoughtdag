import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('./thoughtdag-cli.mjs', import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), 'thoughtdag connection '));
const server = createServer((req, res) => {
  if (req.url !== '/api/cli/status' || !['Bearer explicit', 'Bearer env', 'Bearer cwd'].includes(req.headers.authorization)) {
    res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid CLI session token' })); return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ enabled: true, browserConnected: true, target: req.headers.authorization.slice(7) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const explicit = path.join(dir, 'renamed app session.json');
const envFile = path.join(dir, 'environment.json');
const invoke = (args = [], env = {}) => run(process.execPath, [cli, ...args, 'status'], {
  cwd: dir, env: { ...process.env, THOUGHTDAG_CLI_SESSION: '', ...env }, timeout: 10000,
});
try {
  for (const [file, token] of [[explicit, 'explicit'], [envFile, 'env'], [path.join(dir, '.thoughtdag-cli-session.json'), 'cwd']]) {
    await writeFile(file, JSON.stringify({ version: 1, url, token }), { mode: 0o600 });
  }
  assert.equal(JSON.parse((await invoke(['--session', explicit], { THOUGHTDAG_CLI_SESSION: envFile })).stdout).target, 'explicit');
  console.log('PASS explicit session with spaces overrides environment and cwd');
  assert.equal(JSON.parse((await invoke([], { THOUGHTDAG_CLI_SESSION: envFile })).stdout).target, 'env');
  assert.equal(JSON.parse((await invoke()).stdout).target, 'cwd');
  console.log('PASS environment and cwd discovery precedence');
  await assert.rejects(invoke(['--session', path.join(dir, 'missing')]), error => error.stderr.includes('Session file not found'));
  console.log('PASS missing explicit target fails without silently switching');
  await writeFile(explicit, JSON.stringify({ version: 1, url, token: 'stale' }));
  await assert.rejects(invoke(['--session', explicit]), error => error.stderr.includes('Invalid CLI session token'));
  console.log('PASS stale authentication rejected');
  await writeFile(explicit, JSON.stringify({ version: 1, url: 'https://example.com', token: 'not-sent' }));
  await assert.rejects(invoke(['--session', explicit]), error => error.stderr.includes('local loopback'));
  await writeFile(explicit, JSON.stringify({ version: 2, url, token: 'explicit' }));
  await assert.rejects(invoke(['--session', explicit]), error => error.stderr.includes('unsupported session'));
  console.log('PASS non-loopback and malformed sessions rejected before requests');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
