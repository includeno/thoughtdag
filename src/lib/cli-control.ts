import { API_BASE } from './constants';
import { executeCliCommand } from './cli-executor';
import { useProjects } from '../store/projects';
import {
  CLI_COMMAND_IDS,
  CLI_DEFAULT_PERMISSIONS,
  cliPermissionsAllowGenerativeProcessing,
} from '../../shared/cli-commands.mjs';

const SETTINGS_KEY = 'thoughtdag.cliControl';
const PAGE_CLIENT_ID = crypto.randomUUID();

export interface CliSettings {
  enabled: boolean;
  permissions: string[];
}

export interface CliControlInfo {
  enabled: boolean;
  permissions: string[];
  sessionFile: string;
  cliScript: string;
}

interface CliCommandRequest {
  kind: 'command';
  id: string;
  command: string;
  args: Record<string, unknown>;
  projectId: string | null;
  expiresAt: number;
}

interface CliCancelRequest {
  kind: 'cancel';
  id: string;
}

class CliHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let pollAbort: AbortController | null = null;
let booted = false;
let executionTail: Promise<void> = Promise.resolve();
const cancelledCommands = new Set<string>();
const cancelHandlers = new Map<string, () => void>();

function loopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
    || hostname === '::1' || hostname === '[::1]';
}

/** The CLI bridge exists only on the loopback proxy, never on hosted builds. */
export function cliControlAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const backend = new URL(API_BASE || window.location.origin, window.location.href);
    return loopbackHostname(backend.hostname);
  } catch {
    return false;
  }
}

export function loadCliSettings(): CliSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<CliSettings> : null;
    if (parsed && Array.isArray(parsed.permissions)) {
      return {
        enabled: parsed.enabled === true,
        permissions: parsed.permissions.filter((id): id is string => typeof id === 'string' && CLI_COMMAND_IDS.includes(id)),
      };
    }
  } catch { /* use safe defaults */ }
  return { enabled: false, permissions: [...CLI_DEFAULT_PERMISSIONS] };
}

function activeProject() {
  const state = useProjects.getState();
  return state.projects.find((project) => project.id === state.activeId) ?? null;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new CliHttpError(response.status, typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
  return body;
}

async function postControl(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  return readJson(response);
}

async function register(settings: CliSettings): Promise<CliControlInfo> {
  if (!cliControlAvailable()) throw new Error('CLI control requires the local ThoughtDAG proxy');
  const response = await fetch(`${API_BASE}/api/cli/control`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: PAGE_CLIENT_ID, ...settings, project: activeProject() }),
    signal: AbortSignal.timeout(30_000),
  });
  return await readJson(response) as unknown as CliControlInfo;
}

async function sendResult(id: string, ok: boolean, value: unknown): Promise<void> {
  const payload = {
    clientId: PAGE_CLIENT_ID,
    id,
    ok,
    ...(ok ? { result: value } : { error: value instanceof Error ? value.message : String(value) }),
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await postControl('/api/cli/control/result', payload);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof CliHttpError && error.status >= 400 && error.status < 500) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

function cancelCommand(id: string): void {
  cancelledCommands.add(id);
  try { cancelHandlers.get(id)?.(); } catch { /* cancellation is best-effort */ }
}

function cancelAllRunning(): void {
  for (const id of cancelHandlers.keys()) cancelCommand(id);
}

async function runCommand(request: CliCommandRequest): Promise<void> {
  if (cancelledCommands.has(request.id) || Date.now() >= request.expiresAt) {
    cancelledCommands.delete(request.id);
    return;
  }
  let acknowledged: Record<string, unknown>;
  try {
    acknowledged = await postControl('/api/cli/control/ack', { clientId: PAGE_CLIENT_ID, id: request.id });
  } catch {
    cancelledCommands.delete(request.id);
    return;
  }
  if (acknowledged.accepted !== true || cancelledCommands.has(request.id)) {
    cancelledCommands.delete(request.id);
    return;
  }

  let ok = false;
  let value: unknown;
  try {
    const activeId = useProjects.getState().activeId;
    if (request.projectId !== activeId) {
      throw new Error(`Active project changed before execution (expected ${request.projectId ?? 'none'}, found ${activeId ?? 'none'})`);
    }
    value = await executeCliCommand(request.command, request.args ?? {}, {
      allowGenerativeProcessing: cliPermissionsAllowGenerativeProcessing(loadCliSettings().permissions),
      setCancelHandler(handler) {
        cancelHandlers.set(request.id, handler);
        if (cancelledCommands.has(request.id)) handler();
      },
    });
    ok = true;
  } catch (error) {
    value = error;
  } finally {
    cancelHandlers.delete(request.id);
  }

  try {
    await sendResult(request.id, ok, value);
  } catch (error) {
    if (ok && error instanceof CliHttpError && error.status === 413) {
      await sendResult(request.id, false, new Error('CLI result exceeds the local proxy response limit')).catch(() => {});
    } else {
      console.warn('[thoughtdag] could not report CLI command result:', error);
    }
  } finally {
    cancelledCommands.delete(request.id);
  }
}

function scheduleCommand(request: CliCommandRequest): void {
  if (request.command === 'generation.stop') {
    void runCommand(request);
    return;
  }
  const run = () => runCommand(request);
  executionTail = executionTail.then(run, run);
}

async function pollCommands(signal: AbortSignal): Promise<void> {
  while (!signal.aborted && loadCliSettings().enabled) {
    try {
      const response = await fetch(`${API_BASE}/api/cli/control/next?clientId=${encodeURIComponent(PAGE_CLIENT_ID)}`, { signal });
      if (response.status === 204) continue;
      const event = await readJson(response) as unknown as CliCommandRequest | CliCancelRequest;
      if (event.kind === 'cancel') cancelCommand(event.id);
      else scheduleCommand(event);
    } catch (error) {
      if (signal.aborted || (error instanceof CliHttpError && error.status === 409)) return;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

function startPolling(): void {
  pollAbort?.abort();
  pollAbort = null;
  if (!loadCliSettings().enabled || !cliControlAvailable()) return;
  pollAbort = new AbortController();
  void pollCommands(pollAbort.signal);
}

export async function saveCliSettings(settings: CliSettings): Promise<CliControlInfo> {
  const normalized = {
    enabled: settings.enabled,
    permissions: [...new Set(settings.permissions.filter((id) => CLI_COMMAND_IDS.includes(id)))],
  };
  const previous = loadCliSettings();
  const info = await register(normalized);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  } catch (error) {
    await register(previous).catch(() => {});
    throw error;
  }
  if (!normalized.enabled) cancelAllRunning();
  startPolling();
  return info;
}

export async function inspectCliControl(): Promise<CliControlInfo> {
  return register(loadCliSettings());
}

export function bootCliControl(): void {
  if (booted || !cliControlAvailable()) return;
  booted = true;
  void register(loadCliSettings()).then(startPolling).catch(() => {});
  useProjects.subscribe((state, previous) => {
    if (state.activeId === previous.activeId && state.projects === previous.projects) return;
    void register(loadCliSettings()).catch(() => {});
  });
}
