// Stateful core for the local CLI bridge. Keeping lifecycle rules out of the
// Express handlers makes the protocol deterministic and directly testable.

const ACTIVE_STATES = new Set(['queued', 'delivered', 'running']);
const PROJECT_TRANSITION_COMMANDS = new Set(['project.create', 'project.switch', 'project.import', 'project.delete']);

function projectId(project) {
  return project && typeof project.id === 'string' ? project.id : null;
}

export class CliControlPlane {
  constructor(commandIds, options = {}) {
    this.commandIds = new Set(commandIds);
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.clientTtlMs = options.clientTtlMs ?? 35_000;
    this.retentionMs = options.retentionMs ?? 60 * 60_000;
    this.maxActive = options.maxActive ?? 64;
    this.maxRecords = options.maxRecords ?? 512;
    this.maxResultBytes = options.maxResultBytes ?? 40 * 1024 * 1024;
    this.maxStoredResultBytes = options.maxStoredResultBytes ?? 64 * 1024 * 1024;

    this.clientId = null;
    this.enabled = false;
    this.permissions = new Set();
    this.project = null;
    this.lastSeenAt = 0;
    this.events = [];
    this.commands = new Map();
  }

  _finish(record, { ok, result, error, state = 'completed' }) {
    record.state = state;
    record.ok = ok;
    if (ok) record.result = result;
    else record.error = String(error || 'Command failed');
    record.finishedAt = this.now();
  }

  _cancelRecord(record, message, state = 'cancelled') {
    if (!ACTIVE_STATES.has(record.state)) return false;
    const wasDelivered = record.state === 'delivered' || record.state === 'running';
    if (wasDelivered) {
      this.events.unshift({ kind: 'cancel', id: record.id, clientId: record.clientId });
    }
    this._finish(record, { ok: false, error: message, state });
    return true;
  }

  cleanup() {
    const now = this.now();
    for (const record of this.commands.values()) {
      if (ACTIVE_STATES.has(record.state) && now >= record.expiresAt) {
        this._cancelRecord(record, 'Command deadline expired', 'timed_out');
      }
    }
    for (const [id, record] of this.commands) {
      if (!ACTIVE_STATES.has(record.state) && record.finishedAt != null && now - record.finishedAt >= this.retentionMs) {
        this.commands.delete(id);
      }
    }
    if (this.commands.size > this.maxRecords) {
      const terminal = [...this.commands.values()]
        .filter((record) => !ACTIVE_STATES.has(record.state))
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
      for (const record of terminal) {
        if (this.commands.size <= this.maxRecords) break;
        this.commands.delete(record.id);
      }
    }
    let storedBytes = [...this.commands.values()].reduce((sum, record) => sum + (record.resultBytes ?? 0), 0);
    if (storedBytes > this.maxStoredResultBytes) {
      const terminal = [...this.commands.values()]
        .filter((record) => !ACTIVE_STATES.has(record.state) && (record.resultBytes ?? 0) > 0)
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
      for (const record of terminal) {
        if (storedBytes <= this.maxStoredResultBytes) break;
        storedBytes -= record.resultBytes;
        this.commands.delete(record.id);
      }
    }
    this.events = this.events.filter((event) => {
      if (event.kind === 'cancel') return this.commands.has(event.id);
      return this.commands.get(event.id)?.state === 'queued';
    });
  }

  register({ clientId, enabled, permissions, project }) {
    this.cleanup();
    const nextProjectId = projectId(project);
    const previousProjectId = projectId(this.project);
    const changingClient = !!this.clientId && this.clientId !== clientId;
    const changingProject = !changingClient && previousProjectId !== nextProjectId;

    if (changingClient) {
      for (const record of this.commands.values()) {
        if (ACTIVE_STATES.has(record.state)) {
          this._finish(record, {
            ok: false,
            error: record.state === 'running'
              ? 'The active ThoughtDAG window changed while the command was running; its outcome is unknown'
              : 'The active ThoughtDAG window changed before the command ran',
          });
        }
      }
      this.events = [];
    }

    const allowed = new Set(
      Array.isArray(permissions) ? permissions.filter((id) => this.commandIds.has(id)) : [],
    );
    if (changingProject) {
      for (const record of this.commands.values()) {
        const switchingItself = record.state === 'running' && PROJECT_TRANSITION_COMMANDS.has(record.command);
        if (ACTIVE_STATES.has(record.state) && !switchingItself && record.projectId !== nextProjectId) {
          this._cancelRecord(record, 'The active project changed while the command was pending or running');
        }
      }
    }
    for (const record of this.commands.values()) {
      if (ACTIVE_STATES.has(record.state) && !allowed.has(record.command)) {
        this._cancelRecord(record, `Permission was revoked before execution: ${record.command}`);
      }
    }
    if (!enabled) {
      for (const record of this.commands.values()) {
        this._cancelRecord(record, 'CLI execution was disabled in ThoughtDAG settings');
      }
    }

    this.clientId = clientId;
    this.enabled = enabled === true;
    this.permissions = allowed;
    this.project = project ?? null;
    this.lastSeenAt = this.now();
    return { changingClient, changingProject };
  }

  browserConnected() {
    return !!this.clientId && this.now() - this.lastSeenAt < this.clientTtlMs;
  }

  touch(clientId) {
    this.cleanup();
    if (!clientId || clientId !== this.clientId) return false;
    this.lastSeenAt = this.now();
    return true;
  }

  enqueue(command, args, timeoutMs) {
    this.cleanup();
    if (!this.commandIds.has(command)) return { error: `Unknown command: ${command}`, status: 400 };
    if (!this.enabled) return { error: 'CLI execution is disabled in ThoughtDAG settings', status: 403 };
    if (!this.browserConnected()) return { error: 'No active ThoughtDAG window is connected', status: 409 };
    if (!this.permissions.has(command)) return { error: `Permission not granted: ${command}`, status: 403 };
    const active = [...this.commands.values()].filter((record) => ACTIVE_STATES.has(record.state)).length;
    if (active >= this.maxActive) return { error: 'CLI command queue is full', status: 429 };

    const boundedTimeout = Math.min(60 * 60_000, Math.max(1_000, Number(timeoutMs) || 600_000));
    const createdAt = this.now();
    const record = {
      id: this.createId(),
      command,
      args: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
      clientId: this.clientId,
      projectId: projectId(this.project),
      state: 'queued',
      createdAt,
      expiresAt: createdAt + boundedTimeout,
    };
    this.commands.set(record.id, record);
    this.events.push({ kind: 'command', id: record.id, clientId: record.clientId });
    return { record };
  }

  takeNext(clientId) {
    if (!this.touch(clientId) || !this.enabled) return null;
    while (this.events.length > 0) {
      const event = this.events.shift();
      if (event.clientId !== clientId) continue;
      const record = this.commands.get(event.id);
      if (event.kind === 'cancel') return { kind: 'cancel', id: event.id };
      if (!record || record.state !== 'queued') continue;
      record.state = 'delivered';
      record.deliveredAt = this.now();
      return {
        kind: 'command',
        id: record.id,
        command: record.command,
        args: record.args,
        projectId: record.projectId,
        expiresAt: record.expiresAt,
      };
    }
    return null;
  }

  acknowledge(clientId, id) {
    this.cleanup();
    const record = this.commands.get(id);
    if (!record || record.clientId !== clientId || clientId !== this.clientId) return { found: false };
    if (record.state === 'running') return { found: true, accepted: true, state: record.state };
    if (record.state !== 'delivered') {
      return { found: true, accepted: false, state: record.state, error: record.error };
    }
    record.state = 'running';
    record.startedAt = this.now();
    this.lastSeenAt = this.now();
    return { found: true, accepted: true, state: record.state };
  }

  complete(clientId, id, ok, value) {
    this.cleanup();
    const record = this.commands.get(id);
    if (!record || record.clientId !== clientId || clientId !== this.clientId) return { found: false };
    if (record.state !== 'running') return { found: true, accepted: false, state: record.state };
    if (ok) {
      const resultValue = value === undefined ? null : value;
      let serialized;
      try { serialized = JSON.stringify(resultValue); } catch { serialized = undefined; }
      const resultBytes = serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength;
      if (serialized === undefined) {
        this._finish(record, { ok: false, error: 'CLI result is not JSON-serializable' });
      } else if (resultBytes > this.maxResultBytes) {
        this._finish(record, { ok: false, error: `CLI result exceeds the ${this.maxResultBytes}-byte retention limit` });
      } else {
        record.resultBytes = resultBytes;
        this._finish(record, { ok: true, result: resultValue });
      }
    } else {
      this._finish(record, { ok: false, error: value });
    }
    this.lastSeenAt = this.now();
    return { found: true, accepted: true, state: record.state };
  }

  cancel(id, message = 'Command cancelled by the CLI client') {
    this.cleanup();
    const record = this.commands.get(id);
    if (!record) return { found: false };
    if (ACTIVE_STATES.has(record.state)) this._cancelRecord(record, message);
    return { found: true, state: record.state, running: record.startedAt != null && record.finishedAt != null };
  }

  cancelActive(message) {
    this.cleanup();
    let count = 0;
    // _cancelRecord prepends urgent cancel events. Visit newest-to-oldest so
    // the oldest acknowledged command (the browser's serial executor can
    // only be actively running one ordinary command) ends up delivered first.
    for (const record of [...this.commands.values()].reverse()) {
      if (this._cancelRecord(record, message)) count++;
    }
    return count;
  }

  result(id) {
    this.cleanup();
    const record = this.commands.get(id);
    if (!record) return { found: false };
    if (ACTIVE_STATES.has(record.state)) {
      return { found: true, pending: true, state: record.state };
    }
    return {
      found: true,
      pending: false,
      state: record.state,
      ok: record.ok === true,
      ...(record.ok === true ? { result: record.result } : { error: record.error }),
      finishedAt: record.finishedAt,
    };
  }

  status() {
    this.cleanup();
    return {
      enabled: this.enabled,
      browserConnected: this.browserConnected(),
      project: this.project,
      permissions: [...this.permissions],
      pending: [...this.commands.values()].filter((record) => ACTIVE_STATES.has(record.state)).length,
    };
  }
}
