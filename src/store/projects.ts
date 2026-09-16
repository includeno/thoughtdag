import { create } from 'zustand';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { flushPendingTransaction, useStore } from './index';
import { activeAbortControllers } from './streaming';
import { flushPendingWrites } from '../lib/persistence';
import { buildRuleOutRuleIn } from '../lib/paradigms/rule-out-rule-in';
import { toast, useUiStore } from '../lib/ui-store';
import { t } from '../i18n';

// Project layer: each canvas persists under its own IndexedDB key; this
// module owns the metadata list and the switching choreography.
// Metadata writes use bare idbSet — the debounced idbStorage has a single
// pending slot reserved for the main store and must not be shared.

const META_KEY = 'thoughtdag:projects';
const LEGACY_KEY = 'thoughtdag';

export const projectStorageKey = (id: string) => `thoughtdag:project:${id}`;

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 'chat' (default) = conversation canvas; 'paradigm' = orchestration view, no LLM. */
  kind?: 'chat' | 'paradigm';
  /** Provenance: which paradigm this run canvas was instantiated from. */
  instantiatedFrom?: { name: string; at: string };
  /** The CANONICAL-canvas contract, chapter edition: this canvas
      SUBSCRIBES to a sequence of runner sessions. The main entry is the
      first chapter; `chapters` are later sessions CONTINUING the same
      line of thought (context surgery, then onward — mounted at the main
      line's tail); `branches` are experiment sessions mounted at an
      anchor node. Every entry appends idempotently past its own
      importedCount. One canvas = one line of thought; sessions are its
      physical chapters. */
  sourceSession?: {
    sessionId: string; runner: string; importedCount: number; tailNodeId: string;
    chapters?: { sessionId: string; runner: string; importedCount: number; tailNodeId: string }[];
    branches?: { sessionId: string; runner: string; importedCount: number; tailNodeId: string; anchorNodeId: string }[];
  };
  /** Archived = hidden from the dropdown and Recent work, data untouched.
      Tidying and destroying are different verbs. */
  archived?: boolean;
  /** DERIVED index: which sessions' provenance this canvas holds
      (importSource sessionIds, deduped). Recomputed from the graph on
      every debounced touch — never written by hand, so it cannot drift.
      Lets provenance adoption skip canvases without parsing their
      stored graphs. Absent on legacy metas → slow path fills it in. */
  provenanceSessions?: string[];
}

/** Archive/restore a canvas. Archiving the ACTIVE canvas switches away
 *  first — to the newest unarchived one, or a fresh canvas. */
export async function setProjectArchived(id: string, archived: boolean): Promise<void> {
  const { projects, activeId } = useProjects.getState();
  if (archived && id === activeId) {
    const rest = projects.filter((p) => p.id !== id && !p.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    if (rest.length > 0) await switchProject(rest[0].id);
    else await createProject('My Canvas');
  }
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => (p.id === id ? { ...p, archived } : p)),
  }));
  await saveMeta();
}

/** Update the canonical-canvas ledger after an appendix lands. */
export async function updateSourceSession(projectId: string, patch: Partial<NonNullable<ProjectMeta['sourceSession']>>): Promise<void> {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => (p.id === projectId && p.sourceSession
      ? { ...p, sourceSession: { ...p.sourceSession, ...patch } } : p)),
  }));
  await saveMeta();
}

type LedgerEntryPatch = { importedCount?: number; tailNodeId?: string };

/** Patch whichever ledger entry (main / chapter / branch) holds this
 *  session — the append path doesn't care which kind it landed in. */
export async function patchLedgerEntry(projectId: string, sessionId: string, patch: LedgerEntryPatch): Promise<void> {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => {
      if (p.id !== projectId || !p.sourceSession) return p;
      const ss = p.sourceSession;
      if (ss.sessionId === sessionId) return { ...p, sourceSession: { ...ss, ...patch } };
      return {
        ...p,
        sourceSession: {
          ...ss,
          chapters: ss.chapters?.map((c) => (c.sessionId === sessionId ? { ...c, ...patch } : c)),
          branches: ss.branches?.map((b) => (b.sessionId === sessionId ? { ...b, ...patch } : b)),
        },
      };
    }),
  }));
  await saveMeta();
}

/** Register a newly mounted session in the chapter or branch ledger. */
export async function registerLedgerEntry(
  projectId: string,
  kind: 'chapter' | 'branch',
  entry: { sessionId: string; runner: string; importedCount: number; tailNodeId: string; anchorNodeId?: string },
): Promise<void> {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => {
      if (p.id !== projectId) return p;
      // a NATIVE canvas can host mounted sessions too: the ledger gains
      // an empty main entry — a container, not a subscription
      const ss = p.sourceSession ?? { sessionId: '', runner: '', importedCount: 0, tailNodeId: '' };
      if (kind === 'chapter') {
        return { ...p, sourceSession: { ...ss, chapters: [...(ss.chapters ?? []), { sessionId: entry.sessionId, runner: entry.runner, importedCount: entry.importedCount, tailNodeId: entry.tailNodeId }] } };
      }
      return { ...p, sourceSession: { ...ss, branches: [...(ss.branches ?? []), { ...entry, anchorNodeId: entry.anchorNodeId ?? '' }] } };
    }),
  }));
  await saveMeta();
}

/** Deletion IS unsubscription: drop whichever ledger entry (main /
 *  chapter / branch) holds this session. The main entry degrades to an
 *  empty container while chapters or branches remain; when the last
 *  entry goes, sourceSession goes with it and the canvas is native
 *  again. Reopening the session from the atlas resubscribes. */
export async function removeLedgerEntry(projectId: string, sessionId: string): Promise<void> {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => {
      if (p.id !== projectId || !p.sourceSession) return p;
      const ss = p.sourceSession;
      const chapters = (ss.chapters ?? []).filter((c) => c.sessionId !== sessionId);
      const branches = (ss.branches ?? []).filter((b) => b.sessionId !== sessionId);
      const next = { ...ss, chapters: chapters.length ? chapters : undefined, branches: branches.length ? branches : undefined };
      if (next.sessionId === sessionId) {
        next.sessionId = ''; next.runner = ''; next.importedCount = 0; next.tailNodeId = '';
      }
      if (!next.sessionId && chapters.length === 0 && branches.length === 0) {
        return { ...p, sourceSession: undefined };
      }
      return { ...p, sourceSession: next };
    }),
  }));
  await saveMeta();
}

/** Every session id a canvas subscribes to, across all ledger kinds. */
export function subscribedSessionIds(meta: ProjectMeta): string[] {
  const ss = meta.sourceSession;
  if (!ss) return [];
  return [ss.sessionId, ...(ss.chapters ?? []).map((c) => c.sessionId), ...(ss.branches ?? []).map((b) => b.sessionId)].filter(Boolean);
}

/** Stamp paradigm provenance on a project (persisted with the meta list). */
export async function markInstantiatedFrom(projectId: string, paradigmName: string): Promise<void> {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => (p.id === projectId ? { ...p, instantiatedFrom: { name: paradigmName, at: new Date().toISOString() } } : p)),
  }));
  await saveMeta();
}

interface ProjectsState {
  projects: ProjectMeta[];
  activeId: string | null;
  switching: boolean;
}

export const useProjects = create<ProjectsState>(() => ({
  projects: [],
  activeId: null,
  switching: false,
}));

async function saveMeta(): Promise<void> {
  const { projects, activeId } = useProjects.getState();
  await idbSet(META_KEY, { projects, activeId });
}

// ─── Boot & migration ───────────────────────────────────────────
// Idempotent write order: ① copy graph data → ② write metadata → ③ delete
// legacy key. A crash between steps re-runs the migration harmlessly.
let bootPromise: Promise<void> | null = null;

export function bootProjects(): Promise<void> {
  bootPromise ??= (async () => {
    let meta = await idbGet<{ projects: ProjectMeta[]; activeId: string }>(META_KEY);
    if (!meta || meta.projects.length === 0) {
      const legacy = await idbGet<string>(LEGACY_KEY); // raw persist envelope string
      const id = crypto.randomUUID();
      const now = Date.now();
      if (legacy) await idbSet(projectStorageKey(id), legacy);
      meta = { projects: [{ id, name: 'My Canvas', createdAt: now, updatedAt: now }], activeId: id };
      await idbSet(META_KEY, meta);
      if (legacy) await idbDel(LEGACY_KEY);
    }
    if (!meta.projects.some((p) => p.id === meta.activeId)) {
      meta.activeId = meta.projects[0].id;
    }
    useProjects.setState({ projects: meta.projects, activeId: meta.activeId });
    useStore.persist.setOptions({ name: projectStorageKey(meta.activeId) });
    await useStore.persist.rehydrate(); // fires onFinishHydration → App gate opens
  })().catch(async (e) => {
    console.error('[thoughtdag] project boot failed:', e);
    toast('error', t('toast.projectsLoadFailed'));
    useStore.persist.setOptions({ name: projectStorageKey('recovery') });
    await useStore.persist.rehydrate();
  });
  return bootPromise;
}

// ─── Switching ──────────────────────────────────────────────────
// Danger window: between setOptions and rehydrate completion, any setState
// would write the OLD graph under the NEW key. Defenses: abort all streams
// first (drain), and the `switching` flag disables the switcher UI.
let suppressTouch = false;

async function drainGenerations(): Promise<void> {
  for (const controller of activeAbortControllers.values()) controller.abort();
  const deadline = Date.now() + 1000;
  while (activeAbortControllers.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 0)); // let the final abort writes reach the debounce queue
}

/** Run before the active canvas is swapped out — the canvas record
 *  flushes here so a switch never loses a minute of changes. */
export const beforeSwitchHooks: Array<() => Promise<void>> = [];

export function reportProjectError(error: unknown): void {
  toast('error', error instanceof Error ? error.message : t('toast.projectsLoadFailed'));
}

export async function switchProject(id: string): Promise<void> {
  const { activeId, switching, projects } = useProjects.getState();
  if (switching) throw new Error(t('toast.projectSwitchBusy'));
  if (!projects.some((p) => p.id === id)) throw new Error(t('toast.projectsLoadFailed'));
  if (id === activeId) return;
  useProjects.setState({ switching: true });
  try {
    for (const hook of beforeSwitchHooks) await hook();
    await drainGenerations();
    // Legacy editing surfaces still commit through a short coalescing window.
    // Close that window before changing the persist key, otherwise the graph
    // can land under the old project without its matching Undo transaction.
    if (!flushPendingTransaction('project.switch')) {
      throw new Error(t('toast.projectSwitchBusy'));
    }
    await flushPendingWrites();
    // Prepare the target without changing the storage key or live graph.
    // Zustand's rehydrate swallows read/merge errors, so use its storage,
    // migration and merge explicitly at this transactional boundary.
    const options = useStore.persist.getOptions();
    const stored = await options.storage!.getItem(projectStorageKey(id));
    if (stored && (!stored.state || !Array.isArray(stored.state.nodes) || !Array.isArray(stored.state.edges))) {
      throw new Error(t('toast.projectsLoadFailed'));
    }
    let persisted = stored?.state;
    if (stored && stored.version !== options.version) {
      if (!options.migrate) throw new Error(t('toast.projectsLoadFailed'));
      persisted = await options.migrate(stored.state, stored.version ?? 0);
    }
    const next = options.merge!(persisted, useStore.getState());
    const nextProjects = useProjects.getState().projects.map(p => p.id === id ? { ...p, archived: false } : p);
    // A read can take long enough for an edit/extraction to start. Recheck
    // the outgoing boundary before committing metadata or changing keys.
    if (!flushPendingTransaction('project.switch')) throw new Error(t('toast.projectSwitchBusy'));
    await flushPendingWrites();
    await idbSet(META_KEY, { projects: nextProjects, activeId: id });
    try {
      if (!flushPendingTransaction('project.switch')) throw new Error(t('toast.projectSwitchBusy'));
      await flushPendingWrites();
    } catch (error) {
      await saveMeta();
      throw error;
    }
    suppressTouch = true;
    useStore.persist.setOptions({ name: projectStorageKey(id) });
    useStore.setState({ ...next, selectedNodeId: null, selectedNodeIds: [] });
    useUiStore.setState({ activeNodeId: null, selectedOrganizationRelationId: null, localDepth: 0, knowledgeQuery: {} });
    // opening IS unarchiving: archived means "hidden from the lists", and
    // a canvas the user just switched to is back in the working set —
    // whatever road led here (atlas card, archived group, canonical open)
    useProjects.setState({ activeId: id, projects: nextProjects });
  } finally {
    suppressTouch = false;
    useProjects.setState({ switching: false });
  }
}

// ─── CRUD ───────────────────────────────────────────────────────
export async function createProject(name = 'Untitled', kind: 'chat' | 'paradigm' = 'chat'): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  useProjects.setState((s) => ({
    projects: [...s.projects, { id, name, createdAt: now, updatedAt: now, kind }],
  }));
  try { await switchProject(id); }
  catch (error) {
    useProjects.setState(s => ({ projects: s.projects.filter(p => p.id !== id) }));
    throw error;
  }
  return id;
}

export async function renameProject(id: string, name: string): Promise<void> {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
  }));
  await saveMeta();
}

export async function deleteProject(id: string): Promise<void> {
  const { projects, activeId } = useProjects.getState();
  if (id === activeId) {
    const rest = projects.filter((p) => p.id !== id);
    if (rest.length > 0) await switchProject(rest[0].id);
    else await createProject('My Canvas');
  }
  await idbDel(projectStorageKey(id));
  useProjects.setState((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
  await saveMeta();
  // the why layer's copy goes with it (desktop only; a no-op elsewhere)
  void import('../lib/canvas-record').then((m) => m.removeCanvasRecord(id)).catch(() => undefined);
}

// Register a project entry for graph data already written to its storage key
// (used by JSON import) and switch to it.
export async function adoptImportedProject(
  id: string,
  name: string,
  kind: 'chat' | 'paradigm' = 'chat',
  extras?: Partial<Pick<ProjectMeta, 'instantiatedFrom' | 'sourceSession'>>,
): Promise<void> {
  if (useProjects.getState().projects.some(p => p.id === id)) throw new Error('Project already exists');
  const now = Date.now();
  useProjects.setState((s) => ({
    projects: [...s.projects, { id, name, createdAt: now, updatedAt: now, kind, ...extras }],
  }));
  try { await switchProject(id); }
  catch (error) {
    useProjects.setState(s => ({ projects: s.projects.filter(p => p.id !== id) }));
    throw error;
  }
}

// Seed a new paradigm project with the built-in rule-out/rule-in score and
// switch to it (shared by the landing page and the project switcher).
export async function createBuiltinParadigm(lang: 'en' | 'zh'): Promise<void> {
  const { name, nodes, edges } = buildRuleOutRuleIn(lang);
  const id = crypto.randomUUID();
  await idbSet(projectStorageKey(id), JSON.stringify({ state: { nodes, edges }, version: 2 }));
  await adoptImportedProject(id, name, 'paradigm');
}

if (import.meta.env.DEV) {
  Object.assign(window, { __projects: useProjects });
}

// ─── updatedAt bookkeeping ──────────────────────────────────────
let touchTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((state, prev) => {
  if (suppressTouch) return;
  if (state.nodes === prev.nodes && state.edges === prev.edges) return;
  if (touchTimer) clearTimeout(touchTimer);
  touchTimer = setTimeout(() => {
    const { activeId } = useProjects.getState();
    if (!activeId) return;
    // the provenance fingerprint rides the same debounce: derived from
    // the live graph each time, so it can never drift from the truth
    const sids = [...new Set(useStore.getState().nodes
      .map((n) => n.data.importSource?.sessionId)
      .filter((x): x is string => !!x))];
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => (p.id === activeId ? { ...p, updatedAt: Date.now(), provenanceSessions: sids } : p)),
    }));
    void saveMeta();
  }, 1000);
});
