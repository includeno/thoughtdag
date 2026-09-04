#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitUntilReady(baseUrl) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/models`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the local proxy');
}

async function json(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function runCli(sessionFile, command, timeout = 5_000) {
  const processHandle = spawn(process.execPath, [
    'scripts/thoughtdag-cli.mjs', '--session', sessionFile, command, '--timeout', String(timeout),
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  processHandle.stdout.on('data', (chunk) => { stdout += String(chunk); });
  processHandle.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const done = new Promise((resolve) => processHandle.once('exit', (code) => resolve({ code, stdout, stderr })));
  return { processHandle, done };
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'thoughtdag-cli-http-'));
const sessionFile = path.join(tempDir, 'session.json');
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    THOUGHTDAG_CLI_SESSION_FILE: sessionFile,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

try {
  await waitUntilReady(baseUrl);
  const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
  const auth = { Authorization: `Bearer ${session.token}` };
  const pageHeaders = { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };
  const register = (projectId, permissions = ['node.list', 'node.move', 'question.ask']) => json(baseUrl, '/api/cli/control', {
    method: 'PUT',
    headers: pageHeaders,
    body: JSON.stringify({ clientId: 'page-a', enabled: true, permissions, project: { id: projectId, name: projectId } }),
  });

  assert.equal((await register('project-a')).response.status, 200);
  const denied = await json(baseUrl, '/api/cli/commands', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'node.delete', args: {}, timeoutMs: 5_000 }),
  });
  assert.equal(denied.response.status, 403);

  const accepted = await json(baseUrl, '/api/cli/commands', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'node.list', args: {}, timeoutMs: 5_000 }),
  });
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body.projectId, 'project-a');
  const delivered = await json(baseUrl, '/api/cli/control/next?clientId=page-a');
  assert.equal(delivered.body.id, accepted.body.id);
  assert.equal(delivered.body.projectId, 'project-a');
  const ack = await json(baseUrl, '/api/cli/control/ack', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'page-a', id: accepted.body.id }),
  });
  assert.equal(ack.body.accepted, true);
  const completion = await json(baseUrl, '/api/cli/control/result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'page-a', id: accepted.body.id, ok: true, result: ['node'] }),
  });
  assert.equal(completion.body.accepted, true);
  const result1 = await json(baseUrl, `/api/cli/commands/${accepted.body.id}`, { headers: auth });
  const result2 = await json(baseUrl, `/api/cli/commands/${accepted.body.id}`, { headers: auth });
  assert.deepEqual(result1.body, result2.body);

  const cliRun = runCli(sessionFile, 'node.list');
  const cliEvent = await json(baseUrl, '/api/cli/control/next?clientId=page-a');
  await json(baseUrl, '/api/cli/control/ack', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'page-a', id: cliEvent.body.id }),
  });
  await json(baseUrl, '/api/cli/control/result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'page-a', id: cliEvent.body.id, ok: true, result: [{ id: 'from-cli' }] }),
  });
  const cliResult = await cliRun.done;
  assert.equal(cliResult.code, 0);
  assert.match(cliResult.stdout, /from-cli/);

  const cancellable = await json(baseUrl, '/api/cli/commands', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'question.ask', args: { question: 'slow' }, timeoutMs: 5_000 }),
  });
  await json(baseUrl, '/api/cli/control/next?clientId=page-a');
  await json(baseUrl, '/api/cli/control/ack', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'page-a', id: cancellable.body.id }),
  });
  const cancelled = await json(baseUrl, `/api/cli/commands/${cancellable.body.id}/cancel`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(cancelled.body.state, 'cancelled');
  const cancelEvent = await json(baseUrl, '/api/cli/control/next?clientId=page-a');
  assert.deepEqual(cancelEvent.body, { kind: 'cancel', id: cancellable.body.id });

  const projectBound = await json(baseUrl, '/api/cli/commands', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'node.move', args: {}, timeoutMs: 5_000 }),
  });
  await json(baseUrl, '/api/cli/control/next?clientId=page-a');
  await register('project-b');
  const projectResult = await json(baseUrl, `/api/cli/commands/${projectBound.body.id}`, { headers: auth });
  assert.equal(projectResult.body.state, 'cancelled');
  await json(baseUrl, '/api/cli/control/next?clientId=page-a');

  const timeoutRun = runCli(sessionFile, 'node.move', 1_000);
  const timedEvent = await json(baseUrl, '/api/cli/control/next?clientId=page-a');
  assert.equal(timedEvent.body.command, 'node.move');
  const timeoutResult = await timeoutRun.done;
  assert.equal(timeoutResult.code, 1);
  assert.match(timeoutResult.stderr, /deadline expired|timed out/i);
  const timeoutCancel = await json(baseUrl, '/api/cli/control/next?clientId=page-a');
  assert.deepEqual(timeoutCancel.body, { kind: 'cancel', id: timedEvent.body.id });

  console.log('CLI HTTP protocol tests passed');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  rmSync(tempDir, { recursive: true, force: true });
}

if (child.exitCode && child.exitCode !== 0) throw new Error(stderr || `server exited ${child.exitCode}`);
