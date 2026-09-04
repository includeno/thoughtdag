import { useMemo, useState } from 'react';
import { Check, Pencil, Plus, Tags, Trash2, X } from 'lucide-react';
import { useStore } from '../../store';
import { confirmDialog, useUiStore } from '../../lib/ui-store';
import { fmt, t as ti, useT } from '../../i18n';
import { isImeComposing } from '../../utils';

type EditTarget = { kind: 'tag' | 'type'; id: string; value: string } | null;

export default function NodeMetadataDialog() {
  const t = useT();
  const nodeIds = useUiStore((state) => state.metadataEditorNodeIds);
  const close = useUiStore((state) => state.setMetadataEditorNodeIds);
  const nodes = useStore((state) => state.nodes);
  const taxonomy = useStore((state) => state.taxonomy);
  const createTag = useStore((state) => state.createTag);
  const renameTag = useStore((state) => state.renameTag);
  const deleteTag = useStore((state) => state.deleteTag);
  const createNodeType = useStore((state) => state.createNodeType);
  const renameNodeType = useStore((state) => state.renameNodeType);
  const deleteNodeType = useStore((state) => state.deleteNodeType);
  const setNodeTag = useStore((state) => state.setNodeTag);
  const setNodeCustomType = useStore((state) => state.setNodeCustomType);
  const [tagSearch, setTagSearch] = useState('');
  const [newTag, setNewTag] = useState('');
  const [newType, setNewType] = useState('');
  const [editing, setEditing] = useState<EditTarget>(null);

  const selected = useMemo(() => {
    const wanted = new Set(nodeIds ?? []);
    return nodes.filter((node) => wanted.has(node.id));
  }, [nodeIds, nodes]);
  const shownTags = useMemo(() => {
    const query = tagSearch.trim().toLocaleLowerCase();
    return query ? taxonomy.tags.filter((tag) => tag.name.toLocaleLowerCase().includes(query)) : taxonomy.tags;
  }, [tagSearch, taxonomy.tags]);

  if (!nodeIds) return null;

  const addTag = () => {
    const id = createTag(newTag);
    if (id) {
      setNodeTag(nodeIds, id, true);
      setNewTag('');
    }
  };
  const addType = () => {
    const id = createNodeType(newType);
    if (id) {
      setNodeCustomType(nodeIds, id);
      setNewType('');
    }
  };
  const commitEdit = () => {
    if (!editing) return;
    if (editing.kind === 'tag') renameTag(editing.id, editing.value);
    else renameNodeType(editing.id, editing.value);
    setEditing(null);
  };
  const inputClass = 'flex-1 min-w-0 text-xs bg-surface border border-line rounded-lg px-2.5 py-2 text-ink focus:outline-none focus:ring-1 focus:ring-accent/40';

  return (
    <div className="fixed inset-0 z-[80] bg-ink/25 backdrop-blur-[1px] flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) close(null); }}>
      <section className="bg-card border border-line rounded-2xl shadow-2xl w-full max-w-[640px] max-h-[82vh] overflow-hidden flex flex-col" data-metadata-dialog>
        <header className="px-5 py-4 border-b border-line flex items-center gap-3">
          <span className="w-9 h-9 rounded-xl bg-accent/10 text-accent flex items-center justify-center"><Tags size={17} strokeWidth={1.75} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">{t('metadata.title')}</h2>
            <p className="text-2xs text-ink-faint mt-0.5">{fmt(t('metadata.selected'), { n: selected.length })}</p>
          </div>
          <button onClick={() => close(null)} className="w-8 h-8 rounded-lg text-ink-faint hover:text-ink hover:bg-wash flex items-center justify-center"><X size={16} /></button>
        </header>

        <div className="overflow-y-auto p-5 space-y-6">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-ink">{t('metadata.type')}</h3>
              <span className="text-2xs text-ink-faint">{t('metadata.singleType')}</span>
            </div>
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                onClick={() => setNodeCustomType(nodeIds, undefined)}
                className="text-xs px-3 py-1.5 rounded-full border border-line text-ink-muted hover:bg-wash"
              >
                {t('metadata.noType')}
              </button>
              {taxonomy.nodeTypes.map((type) => {
                const all = selected.length > 0 && selected.every((node) => node.data.customTypeId === type.id);
                return (
                  <div key={type.id} className={`flex items-center rounded-full border ${all ? 'border-accent bg-accent/10' : 'border-line bg-card'}`}>
                    {editing?.kind === 'type' && editing.id === type.id ? (
                      <input
                        autoFocus
                        value={editing.value}
                        onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                        onKeyDown={(event) => { if (event.key === 'Enter' && !isImeComposing(event)) commitEdit(); if (event.key === 'Escape') setEditing(null); }}
                        className="w-28 bg-transparent text-xs px-2.5 py-1.5 focus:outline-none"
                      />
                    ) : (
                      <button onClick={() => setNodeCustomType(nodeIds, type.id)} className="flex items-center gap-1.5 text-xs text-ink px-2.5 py-1.5">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: type.color }} /> {type.name}
                      </button>
                    )}
                    <button onClick={() => editing?.id === type.id ? commitEdit() : setEditing({ kind: 'type', id: type.id, value: type.name })} className="w-6 h-6 mr-0.5 rounded-full text-ink-faint hover:text-accent flex items-center justify-center">
                      {editing?.kind === 'type' && editing.id === type.id ? <Check size={11} /> : <Pencil size={10} />}
                    </button>
                    <button onClick={() => void confirmDialog({ message: fmt(ti('metadata.deleteTypeConfirm'), { name: type.name }), confirmLabel: ti('common.delete'), danger: true }).then((ok) => { if (ok) deleteNodeType(type.id); })} className="w-6 h-6 mr-1 rounded-full text-ink-faint hover:text-red-500 flex items-center justify-center"><Trash2 size={10} /></button>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <input value={newType} onChange={(event) => setNewType(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !isImeComposing(event)) addType(); }} placeholder={t('metadata.newType')} className={inputClass} />
              <button onClick={addType} disabled={!newType.trim()} className="text-xs px-3 rounded-lg bg-accent text-white disabled:opacity-30 flex items-center gap-1"><Plus size={12} /> {t('common.add')}</button>
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-ink">{t('metadata.tags')}</h3>
              <span className="text-2xs text-ink-faint">{t('metadata.multiTags')}</span>
            </div>
            <input value={tagSearch} onChange={(event) => setTagSearch(event.target.value)} placeholder={t('metadata.searchTags')} className={`${inputClass} w-full mb-2`} />
            <div className="border border-line rounded-xl divide-y divide-line/70 max-h-56 overflow-y-auto">
              {shownTags.length === 0 && <p className="px-3 py-4 text-xs text-ink-faint text-center">{t('metadata.noTags')}</p>}
              {shownTags.map((tag) => {
                const count = selected.filter((node) => node.data.tagIds?.includes(tag.id)).length;
                const assigned = selected.length > 0 && count === selected.length;
                return (
                  <div key={tag.id} className="px-3 py-2 flex items-center gap-2">
                    <button onClick={() => setNodeTag(nodeIds, tag.id, !assigned)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
                      <span className={`w-4 h-4 rounded border flex items-center justify-center ${assigned ? 'bg-accent border-accent text-white' : count > 0 ? 'border-accent bg-accent/15' : 'border-line'}`}>
                        {assigned && <Check size={10} strokeWidth={2.5} />}
                      </span>
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: tag.color }} />
                      {editing?.kind === 'tag' && editing.id === tag.id ? (
                        <input
                          autoFocus
                          value={editing.value}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                          onKeyDown={(event) => { if (event.key === 'Enter' && !isImeComposing(event)) commitEdit(); if (event.key === 'Escape') setEditing(null); }}
                          className="flex-1 min-w-0 bg-surface border border-line rounded px-2 py-1 text-xs focus:outline-none"
                        />
                      ) : <span className="text-xs text-ink truncate">{tag.name}</span>}
                      {count > 0 && count < selected.length && <span className="text-2xs text-ink-faint">{count}/{selected.length}</span>}
                    </button>
                    <button onClick={() => editing?.id === tag.id ? commitEdit() : setEditing({ kind: 'tag', id: tag.id, value: tag.name })} className="w-7 h-7 rounded-lg text-ink-faint hover:text-accent hover:bg-wash flex items-center justify-center">
                      {editing?.kind === 'tag' && editing.id === tag.id ? <Check size={12} /> : <Pencil size={11} />}
                    </button>
                    <button onClick={() => void confirmDialog({ message: fmt(ti('metadata.deleteTagConfirm'), { name: tag.name }), confirmLabel: ti('common.delete'), danger: true }).then((ok) => { if (ok) deleteTag(tag.id); })} className="w-7 h-7 rounded-lg text-ink-faint hover:text-red-500 hover:bg-red-50 flex items-center justify-center"><Trash2 size={11} /></button>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2 mt-2">
              <input value={newTag} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !isImeComposing(event)) addTag(); }} placeholder={t('metadata.newTag')} className={inputClass} />
              <button onClick={addTag} disabled={!newTag.trim()} className="text-xs px-3 rounded-lg bg-accent text-white disabled:opacity-30 flex items-center gap-1"><Plus size={12} /> {t('common.add')}</button>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
