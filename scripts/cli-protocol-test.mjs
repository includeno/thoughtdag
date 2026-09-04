#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CliControlPlane } from '../shared/cli-control-plane.mjs';
import {
  CLI_COMMAND_IDS,
  CLI_DANGER_COMMANDS,
  CLI_DEFAULT_PERMISSIONS,
  cliPermissionsAllowGenerativeProcessing,
} from '../shared/cli-commands.mjs';

const KNOWLEDGE_COMMANDS = [
  'organization.connect', 'organization.delete',
  'tag.create', 'tag.rename', 'tag.delete',
  'type.create', 'type.rename', 'type.delete',
  'node.classify',
];
const KNOWLEDGE_DELETE_COMMANDS = ['organization.delete', 'tag.delete', 'type.delete'];
assert.equal(new Set(CLI_COMMAND_IDS).size, CLI_COMMAND_IDS.length, 'catalog command IDs must be unique');
for (const command of KNOWLEDGE_COMMANDS) assert.ok(CLI_COMMAND_IDS.includes(command), `catalog missing ${command}`);
for (const command of KNOWLEDGE_DELETE_COMMANDS) {
  assert.ok(CLI_DANGER_COMMANDS.includes(command), `${command} must stay in the explicit danger group`);
  assert.ok(!CLI_DEFAULT_PERMISSIONS.includes(command), `${command} must be denied by default`);
}
for (const command of KNOWLEDGE_COMMANDS.filter((id) => !KNOWLEDGE_DELETE_COMMANDS.includes(id))) {
  assert.ok(CLI_DEFAULT_PERMISSIONS.includes(command), `${command} should use the normal opt-in permission set`);
}

const executorSource = readFileSync(new URL('../src/lib/cli-executor.ts', import.meta.url), 'utf8');
const executorCommands = new Set([...executorSource.matchAll(/case '([^']+)':/g)].map((match) => match[1]));
assert.deepEqual(CLI_COMMAND_IDS.filter((id) => !executorCommands.has(id)), [], 'every catalog command needs an executor case');
assert.deepEqual([...executorCommands].filter((id) => !CLI_COMMAND_IDS.includes(id)), [], 'every executor case needs a catalog permission');

assert.equal(
  cliPermissionsAllowGenerativeProcessing(['attachment.add']),
  false,
  'attachment permission alone must not authorize implicit model work',
);
assert.equal(
  cliPermissionsAllowGenerativeProcessing(['attachment.add', 'generation.stop']),
  false,
  'stop permission must not authorize starting model work',
);
assert.equal(cliPermissionsAllowGenerativeProcessing(['question.ask']), true);
assert.equal(cliPermissionsAllowGenerativeProcessing(['node.regenerate']), true);

let now = 1_000;
let nextId = 0;
const makePlane = (options = {}) => new CliControlPlane(
  CLI_COMMAND_IDS,
  {
    now: () => now,
    createId: () => `cmd-${++nextId}`,
    ...options,
  },
);
const project = (id) => ({ id, name: id });
const enable = (plane, id = 'page-a', projectId = 'project-a', permissions = ['node.list', 'node.move', 'question.ask', 'generation.stop', 'project.switch']) =>
  plane.register({ clientId: id, enabled: true, permissions, project: project(projectId) });

// Disabled and per-command permission gates are enforced before queueing.
{
  const plane = makePlane();
  assert.equal(plane.enqueue('node.list', {}, 10_000).status, 403);
  enable(plane);
  assert.equal(plane.enqueue('node.delete', {}, 10_000).status, 403);
}

// New knowledge commands use the same per-command permission gate, while all
// destructive variants remain denied until explicitly selected.
{
  const plane = makePlane();
  enable(plane, 'page-a', 'project-a', ['organization.connect']);
  assert.ok(plane.enqueue('organization.connect', { sourceId: 'a', targetId: 'b', kind: 'parent' }, 10_000).record);
  assert.equal(plane.enqueue('organization.delete', { relationId: 'org-a-b' }, 10_000).status, 403);
  assert.equal(plane.enqueue('tag.delete', { tagId: 'tag-a' }, 10_000).status, 403);
  assert.equal(plane.enqueue('type.delete', { typeId: 'type-a' }, 10_000).status, 403);
}

// Delivery has an explicit ACK, and terminal reads are idempotent.
{
  const plane = makePlane();
  enable(plane);
  const { record } = plane.enqueue('node.list', {}, 10_000);
  const event = plane.takeNext('page-a');
  assert.deepEqual(event, {
    kind: 'command', id: record.id, command: 'node.list', args: {},
    projectId: 'project-a', expiresAt: now + 10_000,
  });
  assert.deepEqual(plane.acknowledge('page-a', record.id), { found: true, accepted: true, state: 'running' });
  assert.equal(plane.complete('page-a', record.id, true, ['node']).accepted, true);
  const first = plane.result(record.id);
  const second = plane.result(record.id);
  assert.deepEqual(first, second);
  assert.deepEqual(first.result, ['node']);
}

// Cancellation becomes terminal immediately and emits an urgent browser event
// for a command that was already acknowledged.
{
  const plane = makePlane();
  enable(plane);
  const { record } = plane.enqueue('question.ask', { question: 'slow' }, 10_000);
  plane.takeNext('page-a');
  plane.acknowledge('page-a', record.id);
  const cancelled = plane.cancel(record.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(plane.takeNext('page-a'), { kind: 'cancel', id: record.id });
  assert.equal(plane.result(record.id).ok, false);
  assert.equal(plane.complete('page-a', record.id, true, {}).accepted, false);
}

// A queued command cannot execute after its declared deadline.
{
  const plane = makePlane();
  enable(plane);
  const { record } = plane.enqueue('node.move', {}, 1_000);
  now += 1_001;
  assert.equal(plane.result(record.id).state, 'timed_out');
  assert.equal(plane.takeNext('page-a'), null);
}

// Commands are bound to the project active at enqueue time. A switch cancels
// both server-queued and browser-delivered-but-unacknowledged work.
{
  const plane = makePlane();
  enable(plane);
  const queued = plane.enqueue('node.move', {}, 10_000).record;
  const delivered = plane.enqueue('node.list', {}, 10_000).record;
  assert.equal(plane.takeNext('page-a').id, queued.id);
  assert.equal(plane.takeNext('page-a').id, delivered.id);
  plane.register({
    clientId: 'page-a', enabled: true,
    permissions: ['node.list', 'node.move'], project: project('project-b'),
  });
  assert.equal(plane.result(queued.id).state, 'cancelled');
  assert.equal(plane.result(delivered.id).state, 'cancelled');
  assert.equal(plane.acknowledge('page-a', delivered.id).accepted, false);
}

// Binding also covers the initial no-project state; loading the first project
// must not let an earlier null-bound command enter that new canvas.
{
  const plane = makePlane();
  enable(plane, 'page-a', null);
  const { record } = plane.enqueue('node.list', {}, 10_000);
  enable(plane, 'page-a', 'project-a');
  assert.equal(plane.result(record.id).state, 'cancelled');
}

// When a window is replaced, cancelActive prioritizes the command that was
// actually ACKed over later commands merely delivered into the browser queue.
{
  const plane = makePlane();
  enable(plane);
  const running = plane.enqueue('question.ask', { question: 'slow' }, 10_000).record;
  plane.takeNext('page-a');
  plane.acknowledge('page-a', running.id);
  const delivered = plane.enqueue('node.list', {}, 10_000).record;
  plane.takeNext('page-a');
  plane.cancelActive('window changed');
  assert.deepEqual(plane.takeNext('page-a'), { kind: 'cancel', id: running.id });
  assert.equal(plane.result(delivered.id).state, 'cancelled');
}

// Revoking a permission cancels work that has not started.
{
  const plane = makePlane();
  enable(plane);
  const { record } = plane.enqueue('node.move', {}, 10_000);
  plane.register({ clientId: 'page-a', enabled: true, permissions: ['node.list'], project: project('project-a') });
  assert.equal(plane.result(record.id).state, 'cancelled');
}

// A project-transition command is allowed to publish the new active project
// while it is running; unrelated work from the old project is still cancelled.
{
  const plane = makePlane();
  enable(plane);
  const transition = plane.enqueue('project.switch', { projectId: 'project-b' }, 10_000).record;
  plane.takeNext('page-a');
  plane.acknowledge('page-a', transition.id);
  plane.register({
    clientId: 'page-a', enabled: true,
    permissions: ['project.switch'], project: project('project-b'),
  });
  assert.equal(plane.result(transition.id).state, 'running');
  assert.equal(plane.complete('page-a', transition.id, true, { activeId: 'project-b' }).accepted, true);
}

// Long-poll heartbeats keep a busy but responsive page connected.
{
  const plane = makePlane();
  enable(plane);
  now += 34_000;
  assert.equal(plane.browserConnected(), true);
  assert.equal(plane.touch('page-a'), true);
  now += 34_000;
  assert.equal(plane.browserConnected(), true);
}

// Active work is bounded even when terminal results are retained for retries.
{
  const plane = makePlane({ maxActive: 2 });
  enable(plane);
  plane.enqueue('node.list', {}, 10_000);
  plane.enqueue('node.list', {}, 10_000);
  assert.equal(plane.enqueue('node.list', {}, 10_000).status, 429);
}

// Oversized terminal payloads become explicit failures instead of retaining
// unbounded canvas data in the proxy process.
{
  const plane = makePlane({ maxResultBytes: 16 });
  enable(plane);
  const { record } = plane.enqueue('node.list', {}, 10_000);
  plane.takeNext('page-a');
  plane.acknowledge('page-a', record.id);
  plane.complete('page-a', record.id, true, { text: 'x'.repeat(64) });
  assert.equal(plane.result(record.id).ok, false);
  assert.match(plane.result(record.id).error, /retention limit/);
}

console.log('CLI protocol tests passed');
