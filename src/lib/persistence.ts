import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import type { PersistStorage, StorageValue } from 'zustand/middleware';

// Debounced async storage backed by IndexedDB.
// IndexedDB, not localStorage: attachments carry base64 payloads (PDF page
// images can be tens of MB) far beyond the ~5MB localStorage quota.
//
// OBJECT storage, not createJSONStorage: the JSON wrapper stringifies the
// whole graph SYNCHRONOUSLY on every set() — the debounce only guarded the
// IDB write, not the serialize, so attachment-heavy canvases paid 50-100ms
// per streamed chunk. Here setItem holds a cheap object reference and the
// debounced flush hands the object straight to IndexedDB, whose structured
// clone replaces JSON.stringify entirely.
//
// Debounced because streaming writes one state update per chunk; the
// trailing write is flushed on pagehide/visibility-hidden so a quick tab
// close loses at most WRITE_DELAY_MS of the in-flight response.
const WRITE_DELAY_MS = 1000;

let pending: { name: string; value: unknown } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let beforeFlush: (() => void) | null = null;
let preparingFlush = false;

/** Register the store's synchronous durability-boundary hook without making
    this low-level storage module import the store (which would be circular). */
export function setBeforePersistenceFlush(hook: (() => void) | null): void {
  beforeFlush = hook;
}

function preparePendingValue(): void {
  if (preparingFlush) return;
  preparingFlush = true;
  try {
    beforeFlush?.();
  } finally {
    preparingFlush = false;
  }
  // The hook may have synchronously produced a fresher persisted value and
  // armed a new debounce. This flush owns that value now.
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function flush() {
  void flushPendingWrites().catch(error => console.error('[thoughtdag] save failed; pending data retained:', error));
}

// Awaitable flush — used before switching projects so the outgoing
// project's debounced write lands under its own key.
let writing: Promise<void> | null = null;
export function flushPendingWrites(): Promise<void> {
  if (writing) return writing.then(() => flushPendingWrites());
  writing = (async () => {
    preparePendingValue();
    while (pending) {
      const entry = pending;
      await idbSet(entry.name, entry.value);
      if (pending === entry) pending = null;
      else preparePendingValue();
    }
  })().finally(() => { writing = null; });
  return writing;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/** Object-level persist storage. Generic over the persisted shape. */
export function createIdbObjectStorage<S>(): PersistStorage<S> {
  return {
    getItem: async (name) => {
      const v = await idbGet(name);
      if (v == null) return null;
      // Back-compat: earlier builds stored the JSON string createJSONStorage wrote
      if (typeof v === 'string') {
        return JSON.parse(v) as StorageValue<S>;
      }
      return v as StorageValue<S>;
    },
    setItem: (name, value) => {
      pending = { name, value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, WRITE_DELAY_MS);
    },
    removeItem: async (name) => {
      if (pending?.name === name) pending = null;
      if (!pending && timer) {
        clearTimeout(timer);
        timer = null;
      }
      await idbDel(name);
    },
  };
}
