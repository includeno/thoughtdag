import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from 'idb-keyval';
import type { Attachment, ThoughtNode } from '../types';
import type { CanvasTransaction, EntityChange } from '../store/types';

// The attachment vault: bulky base64 payloads live in their own IndexedDB
// keys instead of inside node.data. Today that means PDF originals — they
// never enter model context (only extractedText does) and are read by
// exactly one consumer, the reader, which is already async. Keeping them
// out of the store shrinks the in-memory graph, every undo snapshot, and
// every persistence clone by the full weight of the PDFs.
//
// Images stay inline: their bytes ride the synchronous context-build path
// into vision requests, and they are typically an order of magnitude
// smaller than documents.
//
// Deleting a node does NOT delete its vault entries (undo must be able to
// resurrect them); orphans are swept by gcVault() at boot instead.

const KEY_PREFIX = 'att-content:';
const vaultKey = (attId: string) => `${KEY_PREFIX}${attId}`;
const payloadId = (attachment: Attachment) => attachment.vaultId ?? attachment.id;

async function contentVaultId(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const shouldVault = (att: Attachment): boolean =>
  att.type === 'application/pdf' && !!att.content && !att.contentInVault;

/** Move a bulky payload into the vault; returns the lightened attachment.
    Non-PDF (and already-vaulted) attachments pass through unchanged. */
export async function internAttachment(att: Attachment): Promise<Attachment> {
  if (att.contentInVault) return att.vaultId ? att : { ...att, vaultId: att.id };
  if (!shouldVault(att)) return att;
  // Whenever bytes are available, derive identity from those bytes. This
  // keeps identity stable after node duplication, coalesces true duplicates,
  // and prevents a stale/imported vaultId from conflating two different PDFs.
  // Already-vaulted legacy entries have no bytes here and keep their old id
  // through the early return above.
  const vaultId = await contentVaultId(att.content);
  await idbSet(vaultKey(vaultId), att.content);
  return { ...att, content: '', contentInVault: true, vaultId };
}

/** The attachment's payload, wherever it lives. '' when the vault entry is
    missing (cleared storage) — callers surface their own error state. */
export async function loadAttachmentContent(att: Attachment): Promise<string> {
  if (!att.contentInVault) return att.content;
  return (await idbGet<string>(vaultKey(payloadId(att)))) ?? '';
}

/** Exports and backups carry the FULL payload: a .thoughtdag.json must stay
    a complete, self-contained copy of the canvas. */
export async function inlineVaultedContent(nodes: ThoughtNode[]): Promise<ThoughtNode[]> {
  const out: ThoughtNode[] = [];
  for (const n of nodes) {
    const atts = n.data.attachments;
    if (!atts?.some((a) => a.contentInVault)) { out.push(n); continue; }
    const inlined: Attachment[] = [];
    for (const a of atts) {
      if (!a.contentInVault) { inlined.push(a); continue; }
      const content = await loadAttachmentContent(a);
      const rest = { ...a, content };
      delete rest.contentInVault;
      inlined.push(rest);
    }
    out.push({ ...n, data: { ...n.data, attachments: inlined } });
  }
  return out;
}

/** Imports strip bulky payloads back INTO the vault before the graph is
    stored; returns the lightened nodes. */
export async function internNodes(nodes: ThoughtNode[]): Promise<ThoughtNode[]> {
  const out: ThoughtNode[] = [];
  for (const n of nodes) {
    const atts = n.data.attachments;
    if (!atts?.some((attachment) => shouldVault(attachment) || (attachment.contentInVault && !attachment.vaultId))) { out.push(n); continue; }
    const interned: Attachment[] = [];
    for (const a of atts) interned.push(await internAttachment(a));
    out.push({ ...n, data: { ...n.data, attachments: interned } });
  }
  return out;
}

async function mapTransactionNodes(
  transactions: CanvasTransaction[],
  transform: (nodes: ThoughtNode[]) => Promise<ThoughtNode[]>,
): Promise<CanvasTransaction[]> {
  const mapped: CanvasTransaction[] = [];
  for (const transaction of transactions) {
    let changed = false;
    const nodeChanges: EntityChange<ThoughtNode>[] = [];
    for (const change of transaction.changes.nodes) {
      const before = change.before ? (await transform([change.before]))[0] : undefined;
      const after = change.after ? (await transform([change.after]))[0] : undefined;
      if (before !== change.before || after !== change.after) changed = true;
      nodeChanges.push({ ...change, ...(before ? { before } : {}), ...(after ? { after } : {}) });
    }
    mapped.push(changed
      ? { ...transaction, changes: { ...transaction.changes, nodes: nodeChanges } }
      : transaction);
  }
  return mapped;
}

/** Make recovery history self-contained in a backup, including attachments
    that exist only in a deleted-node transaction. */
export async function inlineVaultedTransactions(transactions: CanvasTransaction[]): Promise<CanvasTransaction[]> {
  return mapTransactionNodes(transactions, inlineVaultedContent);
}

/** Restore imported transaction-only binaries to the local vault. */
export async function internTransactions(transactions: CanvasTransaction[]): Promise<CanvasTransaction[]> {
  return mapTransactionNodes(transactions, internNodes);
}

/** Add every attachment payload identity referenced by current state or by
    retained before/after changes. Used by boot GC so Undo never revives an
    attachment whose binary was swept. */
export function collectVaultReferences(
  nodes: readonly ThoughtNode[],
  transactions: readonly CanvasTransaction[] = [],
  into = new Set<string>(),
): Set<string> {
  const collectNodes = (items: readonly ThoughtNode[]) => {
    for (const node of items) {
      for (const attachment of node.data.attachments ?? []) into.add(payloadId(attachment));
    }
  };
  collectNodes(nodes);
  for (const transaction of transactions) {
    for (const change of transaction.changes.nodes ?? []) {
      if (change.before) collectNodes([change.before]);
      if (change.after) collectNodes([change.after]);
    }
  }
  return into;
}

/** Sweep vault entries no canvas references anymore. `referencedIds` must
    cover EVERY project's attachments — run it from boot, after the project
    list is known. */
export async function gcVault(referencedIds: Set<string>): Promise<number> {
  const all = (await idbKeys()) as string[];
  let swept = 0;
  for (const k of all) {
    if (typeof k !== 'string' || !k.startsWith(KEY_PREFIX)) continue;
    if (referencedIds.has(k.slice(KEY_PREFIX.length))) continue;
    await idbDel(k);
    swept++;
  }
  return swept;
}
