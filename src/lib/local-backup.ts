import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { flushPendingTransaction, useStore, stripTransient } from '../store';
import { useProjects, type ProjectMeta } from '../store/projects';
import { toast, useUiStore } from './ui-store';
import { t } from '../i18n';
import { EXPORT_FORMAT_VERSION } from './export';
import { isViewerMode } from './viewer';
import { inlineVaultedContent, inlineVaultedTransactions } from './attachment-vault';
import type { CanvasEvent, OrganizationRelation, ThoughtEdge, ThoughtNode } from '../types';
import type { CanvasTransaction, ProjectTaxonomy, StoreState } from '../store/types';

// Automatic local backup via the File System Access API (Chromium): the user
// grants a FOLDER once; afterwards every canvas change is debounced and the
// active project silently (re)written as <name>.thoughtdag.json — a real file
// on disk that survives any browser-data wipe. Point the folder at a synced
// directory (Dropbox / iCloud / Drive desktop) and it doubles as cross-device
// sync, still with zero servers.

const HANDLE_KEY = 'thoughtdag.backupDirHandle';
const DEBOUNCE_MS = 60_000;

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
};

export const backupSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

let handle: DirHandle | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

type BackupRelevantState = Pick<
  StoreState,
  | 'nodes'
  | 'edges'
  | 'events'
  | 'organizationRelations'
  | 'taxonomy'
  | 'transactions'
  | 'undoableTransactionIds'
  | 'redoableTransactionIds'
  | 'revision'
>;

export function backupRelevantStateChanged(state: BackupRelevantState, previous: BackupRelevantState): boolean {
  return state.nodes !== previous.nodes
    || state.edges !== previous.edges
    || state.events !== previous.events
    || state.organizationRelations !== previous.organizationRelations
    || state.taxonomy !== previous.taxonomy
    || state.transactions !== previous.transactions
    || state.undoableTransactionIds !== previous.undoableTransactionIds
    || state.redoableTransactionIds !== previous.redoableTransactionIds
    || state.revision !== previous.revision;
}

export interface ProjectBackupPayloadV2 {
  schemaVersion: typeof EXPORT_FORMAT_VERSION;
  version: typeof EXPORT_FORMAT_VERSION;
  name: string;
  projectId: string | null;
  sourceSession?: ProjectMeta['sourceSession'];
  exportedAt: string;
  instantiatedFrom?: ProjectMeta['instantiatedFrom'];
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
  events: CanvasEvent[];
  organizationRelations: OrganizationRelation[];
  taxonomy: ProjectTaxonomy;
  transactions: CanvasTransaction[];
  undoableTransactionIds: string[];
  redoableTransactionIds: string[];
  revision: number;
}

/** Build the same complete v2 recovery envelope used by explicit exports.
    Vaulted binaries in both the live graph and retained transaction history
    are inlined so the file never depends on this browser's IndexedDB. */
export async function buildActiveProjectBackupPayload(): Promise<ProjectBackupPayloadV2 | null> {
  // A legacy/pre-only mutation may still be waiting for the transaction
  // safety net. Commit it before taking a recovery snapshot; an in-flight
  // generation/extraction is not a coherent backup boundary, so retry later.
  if (!flushPendingTransaction('backup.pending')) return null;

  const {
    nodes: rawNodes,
    edges,
    events,
    organizationRelations,
    taxonomy,
    transactions: rawTransactions,
    undoableTransactionIds,
    redoableTransactionIds,
    revision,
  } = useStore.getState();
  if (rawNodes.length === 0) return null;

  const { projects, activeId } = useProjects.getState();
  const project = projects.find((candidate) => candidate.id === activeId);
  const name = project?.name ?? 'canvas';
  const [nodes, transactions] = await Promise.all([
    inlineVaultedContent(rawNodes),
    inlineVaultedTransactions(rawTransactions),
  ]);

  return {
    schemaVersion: EXPORT_FORMAT_VERSION,
    version: EXPORT_FORMAT_VERSION,
    name,
    projectId: activeId,
    sourceSession: project?.sourceSession,
    exportedAt: new Date().toISOString(),
    ...(project?.instantiatedFrom ? { instantiatedFrom: project.instantiatedFrom } : {}),
    nodes: stripTransient(nodes),
    edges,
    events,
    organizationRelations,
    taxonomy,
    transactions,
    undoableTransactionIds,
    redoableTransactionIds,
    revision,
  };
}

/** Write the ACTIVE canvas as one real file. Both paths go through here —
    the debounced auto-backup and the dialog's "back up now" button back up
    the current canvas only; other canvases get their file whenever they
    are the active one. Returns the canvas name written, null if nothing
    was (no folder yet / empty canvas). */
export async function backupActiveProject(): Promise<string | null> {
  if (!handle) return null;
  const backup = await buildActiveProjectBackupPayload();
  if (!backup) return null;
  const projectName = backup.name;
  const base = (projectName.replace(/[\\/:*?"<>|]/g, '_') || 'canvas').slice(0, 48);
  // Mirror names can share long prefixes; keep the session suffix and cli/ drawer.
  const name = backup.sourceSession?.sessionId ? `${base}-${backup.sourceSession.sessionId.slice(0, 8)}` : base;
  const payload = JSON.stringify(backup);
  const dir = backup.sourceSession ? await handle.getDirectoryHandle('cli', { create: true }) : handle;
  const file = await dir.getFileHandle(`${name}.thoughtdag.json`, { create: true });
  const w = await file.createWritable();
  await w.write(payload);
  await w.close();
  localStorage.setItem('thoughtdag.lastBackupAt', String(Date.now()));
  useUiStore.getState().setLastAutoBackupAt(Date.now());
  return projectName;
}

function schedule(): void {
  dirty = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (!dirty) return;
    dirty = false;
    void backupActiveProject().catch((err) => {
      console.warn('[thoughtdag] auto-backup write failed:', err);
    });
  }, DEBOUNCE_MS);
}

function watch(): void {
  useStore.subscribe((state, prev) => {
    if (backupRelevantStateChanged(state, prev)) schedule();
  });
  useProjects.subscribe((state, previous) => {
    const project = state.projects.find((candidate) => candidate.id === state.activeId);
    const oldProject = previous.projects.find((candidate) => candidate.id === previous.activeId);
    if (state.activeId !== previous.activeId
      || project?.name !== oldProject?.name
      || project?.instantiatedFrom?.name !== oldProject?.instantiatedFrom?.name
      || project?.instantiatedFrom?.at !== oldProject?.instantiatedFrom?.at) schedule();
  });
}

let watching = false;
function ensureWatch(): void {
  if (!watching) { watching = true; watch(); }
}

/** User gesture: pick (or re-pick) the backup folder. */
export async function enableAutoBackup(): Promise<boolean> {
  try {
    const dir = (await (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> })
      .showDirectoryPicker({ mode: 'readwrite' }));
    handle = dir;
    await idbSet(HANDLE_KEY, dir);
    useUiStore.getState().setAutoBackupDir(dir.name);
    ensureWatch();
    await backupActiveProject();
    toast('success', t('backup.enabled'));
    return true;
  } catch {
    return false; // picker dismissed
  }
}

export async function disableAutoBackup(): Promise<void> {
  handle = null;
  await idbDel(HANDLE_KEY);
  useUiStore.getState().setAutoBackupDir(null);
}

/** Boot: restore the stored handle; if permission needs a gesture, surface
    one sticky toast whose button re-activates it. */
export async function bootAutoBackup(): Promise<void> {
  if (isViewerMode || !backupSupported) return;
  const stored = await idbGet<DirHandle>(HANDLE_KEY).catch(() => null);
  if (!stored) return;
  useUiStore.getState().setAutoBackupDir(stored.name);
  const perm = await stored.queryPermission?.({ mode: 'readwrite' }).catch(() => 'prompt');
  if (perm === 'granted') {
    handle = stored;
    ensureWatch();
    return;
  }
  toast('info', t('backup.reauth'), 0, {
    label: t('backup.reauthBtn'),
    run: () => {
      void stored.requestPermission?.({ mode: 'readwrite' }).then((p) => {
        if (p === 'granted') { handle = stored; ensureWatch(); toast('success', t('backup.enabled')); }
      });
    },
  });
}
