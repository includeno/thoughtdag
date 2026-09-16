import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, BookOpen, CircleDot, Copy, Files, FlaskConical, GitFork, Maximize2, RefreshCw, StickyNote, Tags, Trash2, UserRoundPlus } from 'lucide-react';
import { useStore } from '../store';
import { useUiStore, confirmDialog, toast } from '../lib/ui-store';
import EditModeSelect from './ui/EditModeSelect';
import { nodeEditMode } from '../lib/edit-mode';
import { recapToNote } from '../lib/recap';
import { useT, fmt, t as ti } from '../i18n';

// Right-click on a node: the app's own context menu (same visual language
// as the toolbar's ⋯ menu). The browser menu stays available where it is
// genuinely useful — right-clicking selected TEXT is not intercepted
// (see the onNodeContextMenu guard in App).

export default function NodeContextMenu({ x, y, nodeId, onClose }: {
  x: number; y: number; nodeId: string; onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));

  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [onClose]);

  if (!node) return null;
  const kind = node.data.stepKind;
  const mode = nodeEditMode(node.data);
  const isContent = !!kind; // note / file / link / frame
  const hasResponse = !isContent && mode !== 'manual' && !!node.data.response && !node.data.isLoading;
  const copyText = isContent
    ? (kind === 'note' || kind === 'link' ? node.data.question : '')
    : mode === 'manual' ? node.data.question : node.data.response;

  const item = 'w-full text-left px-3 py-2 text-xs text-ink hover:bg-wash transition-colors flex items-center gap-2.5';
  const icon = 'text-ink-faint shrink-0';

  // Keep the menu inside the viewport (it renders at the pointer)
  const MENU_W = 200;
  const MENU_H = 500;
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H - 8);

  const run = (fn: () => void) => () => { onClose(); fn(); };

  return createPortal((
    <div ref={ref} className="fixed z-[70] bg-card border border-line rounded-xl shadow-lg py-1 w-[200px] animate-fade-in" style={{ left, top }}>
      {mode && <div className="px-3 py-2"><EditModeSelect value={mode} disabled={node.data.isLoading} onChange={(next) => { useStore.getState().setNodeEditMode(nodeId, next); onClose(); }} /></div>}
      {!isContent && (
        <button className={item} onClick={run(() => {
          useStore.getState().setSelectedNodeId(nodeId);
          useUiStore.getState().setPanelOpen(true);
        })}>
          <BookOpen size={14} strokeWidth={1.75} className={icon} /> {t('ctx.openPanel')}
        </button>
      )}
      {kind !== 'frame' && (
        <>
          <button className={item} onClick={run(() => {
            useStore.getState().setSelectedNodeId(nodeId);
            useUiStore.getState().setActiveNodeId(nodeId);
            useUiStore.getState().setLocalDepth(1);
          })}>
            <CircleDot size={14} strokeWidth={1.75} className={icon} /> {t('knowledge.focusLocal')}
          </button>
          <button className={item} onClick={run(() => { useStore.getState().createOrganizationNode(nodeId, 'parent'); })}>
            <UserRoundPlus size={14} strokeWidth={1.75} className={`${icon} rotate-180`} /> {t('knowledge.createParent')}
          </button>
          <button className={item} onClick={run(() => { useStore.getState().createOrganizationNode(nodeId, 'child'); })}>
            <UserRoundPlus size={14} strokeWidth={1.75} className={icon} /> {t('knowledge.createChild')}
          </button>
          <button className={item} onClick={run(() => useUiStore.getState().setMetadataEditorNodeIds([nodeId]))}>
            <Tags size={14} strokeWidth={1.75} className={icon} /> {t('metadata.edit')}
          </button>
          <div className="h-px bg-line my-1" />
        </>
      )}
      {hasResponse && (
        <button className={item} onClick={run(() => useUiStore.getState().setResponseViewerNodeId(nodeId))}>
          <Maximize2 size={14} strokeWidth={1.75} className={icon} /> {t('ctx.readingView')}
        </button>
      )}
      {hasResponse && mode === 'ai' && (
        <button className={item} onClick={run(() => { void useStore.getState().rerunNode(nodeId); })}>
          <RefreshCw size={14} strokeWidth={1.75} className={icon} /> {t('ctx.rerun')}
        </button>
      )}
      {hasResponse && mode === 'ai' && (
        <button className={item} title={ti('actions.regenBranchTitle')} onClick={run(() => { void useStore.getState().regenerate(nodeId); })}>
          <GitFork size={14} strokeWidth={1.75} className={icon} /> {t('ctx.regenBranch')}
        </button>
      )}
      {hasResponse && (
        <button className={item} onClick={run(() => { void recapToNote(nodeId); })}>
          <StickyNote size={14} strokeWidth={1.75} className={icon} /> {t('continue.summarize')}
        </button>
      )}
      {copyText && (
        <button className={item} onClick={run(() => {
          void navigator.clipboard.writeText(copyText).then(() => toast('success', ti('ctx.copied')));
        })}>
          <Copy size={14} strokeWidth={1.75} className={icon} /> {t('ctx.copyContent')}
        </button>
      )}
      {!isContent && (
        <button className={item} title={ti('exp.takeTitle')} onClick={run(() => {
          void import('../lib/experiment-loop').then((m) => m.takeToExperiment(nodeId, 'branch'));
        })} data-take-to-experiment>
          <FlaskConical size={14} strokeWidth={1.75} className={icon} /> {t('exp.take')}
        </button>
      )}
      {!isContent && (
        <button className={item} title={ti('exp.continueTitle')} onClick={run(() => {
          void import('../lib/experiment-loop').then((m) => m.takeToExperiment(nodeId, 'continue'));
        })} data-take-to-continue>
          <BookOpen size={14} strokeWidth={1.75} className={icon} /> {t('exp.continue')}
        </button>
      )}
      <button className={item} onClick={run(() => useStore.getState().duplicateNode(nodeId))}>
        <Files size={14} strokeWidth={1.75} className={icon} /> {t('ctx.duplicate')}
      </button>
      <button className={item} onClick={run(() => useStore.getState().setArchived([nodeId], !node.data.archived))}>
        {node.data.archived
          ? <ArchiveRestore size={14} strokeWidth={1.75} className={icon} />
          : <Archive size={14} strokeWidth={1.75} className={icon} />}
        {node.data.archived ? t('ctx.unarchive') : t('archive.label')}
      </button>
      <div className="h-px bg-line my-1" />
      <button
        className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-50 transition-colors flex items-center gap-2.5"
        onClick={run(() => {
          void confirmDialog({
            title: ti('confirm.deleteNodesTitle'),
            message: fmt(ti('confirm.deleteNodes'), { n: 1 }),
            confirmLabel: ti('common.delete'),
            danger: true,
          }).then((ok) => { if (ok) useStore.getState().deleteNode(nodeId); });
        })}
      >
        <Trash2 size={14} strokeWidth={1.75} className="shrink-0" /> {t('common.delete')}
      </button>
    </div>
  ), document.body);
}
