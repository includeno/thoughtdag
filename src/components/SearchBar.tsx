import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronDown, FileText, Frame, Link2, MessageSquare, Minimize2, Search, SlidersHorizontal, StickyNote, X } from 'lucide-react';
import { useStore } from '../store';
import { useUiStore } from '../lib/ui-store';
import { type SearchHit } from '../lib/canvas-search';
import {
  knowledgeQueryIsActive,
  type KnowledgeQueryProjection,
  resolveKnowledgeQuery,
  type ArchivedFilter,
  type KnowledgeQuery,
  type RelationDomain,
  type RelationScope,
  type SystemNodeKind,
} from '../lib/knowledge';
import { isImeComposing } from '../utils';
import { useT, fmt } from '../i18n';
import type { ThoughtNode } from '../types';

// One deterministic query model powers the result list, canvas searchlight,
// Tree and Card views. Text and every metadata/relation dimension combine
// with AND; no text is required for filter-only discovery.

const KIND_ICON = {
  qa: MessageSquare, note: StickyNote, file: FileText,
  link: Link2, frame: Frame, distill: Minimize2,
} as const;

const SHOW_LIMIT = 50;
const EMPTY_QUERY: KnowledgeQuery = {
  archived: 'any',
  relation: { scope: 'all', domain: 'combined' },
};

function kindOf(node: ThoughtNode): SearchHit['kind'] {
  const kind = node.data.stepKind;
  if (kind === 'note' || kind === 'file' || kind === 'link' || kind === 'frame') return kind;
  if (node.data.condensedFrom?.length) return 'distill';
  return 'qa';
}

function fallbackSnippet(node: ThoughtNode): string {
  return (
    node.data.linkTitle
    || node.data.question
    || node.data.response
    || node.data.attachments?.[0]?.name
    || node.data.summary
    || '—'
  ).replace(/\s+/g, ' ').slice(0, 180);
}

export default function SearchBar({
  open,
  projection,
  onClose,
  onLocate,
}: {
  open: boolean;
  projection: KnowledgeQueryProjection;
  onClose: () => void;
  onLocate: (nodeId: string) => void;
}) {
  const t = useT();
  const nodes = useStore((state) => state.nodes);
  const taxonomy = useStore((state) => state.taxonomy);
  const activeNodeId = useUiStore((state) => state.activeNodeId);
  const knowledgeQuery = useUiStore((state) => state.knowledgeQuery);
  const setKnowledgeQuery = useUiStore((state) => state.setKnowledgeQuery);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);
  const dateInvalid = !!(
    knowledgeQuery.createdAt?.from
    && knowledgeQuery.createdAt?.to
    && knowledgeQuery.createdAt.from > knowledgeQuery.createdAt.to
  );
  const effectiveQuery = useMemo<KnowledgeQuery>(
    () => resolveKnowledgeQuery(knowledgeQuery, activeNodeId),
    [knowledgeQuery, activeNodeId],
  );
  const matches: SearchHit[] = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return projection.hits.flatMap((hit) => {
      const node = byId.get(hit.nodeId);
      return node ? [{ nodeId: node.id, kind: kindOf(node), archived: !!node.data.archived,
        count: hit.occurrenceCount, ...(hit.excerpt ?? { snippet: fallbackSnippet(node), matchStart: 0, matchLen: 0 }),
      }] : [];
    });
  }, [nodes, projection]);
  const [limit, setLimit] = useState(SHOW_LIMIT);
  const active = knowledgeQueryIsActive(effectiveQuery);
  const boundedCursor = Math.min(cursor, Math.max(0, Math.min(limit, matches.length) - 1));

  if (!open) return null;

  const updateQuery = (patch: Partial<KnowledgeQuery>) => {
    setKnowledgeQuery({ ...knowledgeQuery, ...patch });
    setCursor(0);
  };
  const locate = (hit: SearchHit) => {
    onLocate(hit.nodeId);
    const query = (effectiveQuery.text ?? '').trim().toLowerCase();
    setTimeout(() => {
      const panel = document.querySelector('[data-focus-panel]');
      if (!panel || !query) return;
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      let textNode: Node | null;
      while ((textNode = walker.nextNode())) {
        if (!textNode.textContent?.toLowerCase().includes(query)) continue;
        const element = textNode.parentElement;
        element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        element?.animate(
          [{ backgroundColor: 'rgba(107, 92, 231, 0.22)' }, { backgroundColor: 'transparent' }],
          { duration: 1800, easing: 'ease-out' },
        );
        break;
      }
    }, 500);
  };
  const selectedKind = knowledgeQuery.systemKinds?.[0] ?? '';
  const selectedType = knowledgeQuery.customTypeIds?.[0] ?? '';
  const relation = knowledgeQuery.relation ?? { scope: 'all' as const, domain: 'combined' as const };
  const selectClass = 'w-full text-xs bg-surface border border-line rounded-lg px-2.5 py-2 text-ink focus:outline-none focus:ring-1 focus:ring-accent/40';
  const labelClass = 'block text-2xs text-ink-faint mb-1';

  const systemKinds = [
    ['qa', 'search.kindQa'], ['human', 'search.kindHuman'], ['prompt', 'search.kindPrompt'],
    ['note', 'search.kindNote'], ['file', 'search.kindFile'], ['link', 'search.kindLink'],
    ['frame', 'search.kindFrame'], ['review', 'search.kindReview'], ['synthesis', 'search.kindSynthesis'],
  ] as const;
  const scopes = [
    ['all', 'search.scopeAll'], ['ancestors', 'search.scopeAncestors'],
    ['descendants', 'search.scopeDescendants'], ['branch', 'search.scopeBranch'],
    ['backlinks', 'search.scopeBacklinks'], ['orphans', 'search.scopeOrphans'],
  ] as const;

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 w-[min(680px,calc(100vw-32px))]" data-canvas-search>
      <div className="bg-card border border-line rounded-xl shadow-xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 transition-shadow focus-within:ring-1 focus-within:ring-accent/40">
          <Search size={15} strokeWidth={1.75} className="text-ink-faint shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={knowledgeQuery.text ?? ''}
            onChange={(event) => updateQuery({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
              if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((current) => Math.min(current + 1, Math.max(0, Math.min(limit, matches.length) - 1))); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((current) => Math.max(current - 1, 0)); }
              if (event.key === 'Enter' && !isImeComposing(event) && matches[boundedCursor]) { event.preventDefault(); locate(matches[boundedCursor]); }
            }}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent text-sm text-ink placeholder-ink-faint focus:outline-none"
            data-search-input
          />
          {active && <span className="text-2xs text-ink-faint shrink-0">{fmt(t('search.count'), { n: matches.length })}</span>}
          <button
            onClick={() => setFiltersOpen((value) => !value)}
            title={t('search.filters')}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${filtersOpen ? 'bg-accent/10 text-accent' : 'text-ink-faint hover:bg-wash'}`}
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
          </button>
          <button onClick={onClose} className="text-ink-faint hover:text-ink transition-colors shrink-0"><X size={14} strokeWidth={1.75} /></button>
        </div>

        {filtersOpen && (
          <div className="border-t border-line/60 bg-wash/40 px-4 py-3" data-search-filters>
            <div className="grid grid-cols-3 gap-3">
              <label>
                <span className={labelClass}>{t('search.systemKind')}</span>
                <select value={selectedKind} onChange={(event) => updateQuery({ systemKinds: event.target.value ? [event.target.value as SystemNodeKind] : [] })} className={selectClass}>
                  <option value="">{t('search.anyKind')}</option>
                  {systemKinds.map(([kind, label]) => <option key={kind} value={kind}>{t(label)}</option>)}
                </select>
              </label>
              <label>
                <span className={labelClass}>{t('search.customType')}</span>
                <select value={selectedType} onChange={(event) => updateQuery({ customTypeIds: event.target.value ? [event.target.value] : [] })} className={selectClass}>
                  <option value="">{t('search.anyType')}</option>
                  {taxonomy.nodeTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                </select>
              </label>
              <label>
                <span className={labelClass}>{t('search.archive')}</span>
                <select value={knowledgeQuery.archived ?? 'any'} onChange={(event) => updateQuery({ archived: event.target.value as ArchivedFilter })} className={selectClass}>
                  <option value="any">{t('search.archiveAny')}</option>
                  <option value="active">{t('search.archiveActive')}</option>
                  <option value="archived">{t('search.archiveArchived')}</option>
                </select>
              </label>
              <label>
                <span className={labelClass}>{t('search.relationScope')}</span>
                <select value={relation.scope} onChange={(event) => updateQuery({ relation: { ...relation, scope: event.target.value as RelationScope, anchorNodeId: activeNodeId ?? undefined } })} className={selectClass}>
                  {scopes.map(([scope, label]) => <option key={scope} value={scope}>{t(label)}</option>)}
                </select>
              </label>
              <label>
                <span className={labelClass}>{t('search.relationDomain')}</span>
                <select value={relation.domain ?? 'combined'} onChange={(event) => updateQuery({ relation: { ...relation, domain: event.target.value as RelationDomain } })} className={selectClass}>
                  <option value="combined">{t('search.domainCombined')}</option>
                  <option value="context">{t('search.domainContext')}</option>
                  <option value="organization">{t('search.domainOrganization')}</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label>
                  <span className={labelClass}>{t('search.createdFrom')}</span>
                  <input type="date" value={knowledgeQuery.createdAt?.from ?? ''} onChange={(event) => updateQuery({ createdAt: { ...knowledgeQuery.createdAt, from: event.target.value || undefined } })} className={selectClass} />
                </label>
                <label>
                  <span className={labelClass}>{t('search.createdTo')}</span>
                  <input type="date" value={knowledgeQuery.createdAt?.to ?? ''} onChange={(event) => updateQuery({ createdAt: { ...knowledgeQuery.createdAt, to: event.target.value || undefined } })} className={selectClass} />
                </label>
              </div>
            </div>
            {taxonomy.tags.length > 0 && (
              <div className="mt-3">
                <span className={labelClass}>{t('search.tags')}</span>
                <div className="flex flex-wrap gap-1.5">
                  {taxonomy.tags.map((tag) => {
                    const selected = knowledgeQuery.tagIds?.includes(tag.id) ?? false;
                    return (
                      <button
                        key={tag.id}
                        onClick={() => {
                          const ids = new Set(knowledgeQuery.tagIds ?? []);
                          if (selected) ids.delete(tag.id); else ids.add(tag.id);
                          updateQuery({ tagIds: [...ids], tagMatch: 'all' });
                        }}
                        className={`px-2 py-1 rounded-full border text-2xs flex items-center gap-1.5 ${selected ? 'border-accent bg-accent/10 text-accent' : 'border-line text-ink-muted hover:bg-card'}`}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} /> {tag.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="mt-3 flex items-center justify-between">
              <div className="text-2xs text-red-600">
                {dateInvalid
                  ? t('search.invalidDate')
                  : relation.scope !== 'all' && relation.scope !== 'orphans' && !activeNodeId
                    ? t('search.scopeNeedsActive')
                    : projection.activeOutsideFilter ? t('search.activeOutsideFilter') : ''}
              </div>
              <button onClick={() => { setKnowledgeQuery(EMPTY_QUERY); setCursor(0); }} className="text-2xs text-ink-muted hover:text-accent flex items-center gap-1">
                <X size={11} /> {t('search.clearFilters')}
              </button>
            </div>
          </div>
        )}

        {active && matches.length > 0 && (
          <ul className="border-t border-line/60 max-h-72 overflow-y-auto py-1">
            {matches.slice(0, limit).map((match, index) => {
              const Icon = KIND_ICON[match.kind];
              const node = nodes.find((item) => item.id === match.nodeId);
              const title = node?.data.linkTitle || node?.data.question || t('knowledge.untitled');
              return (
                <li key={match.nodeId}>
                  <button
                    onClick={() => locate(match)}
                    onMouseEnter={() => setCursor(index)}
                    className={`w-full text-left px-4 py-2 transition-colors ${index === boundedCursor ? 'bg-accent/8' : ''} ${match.archived ? 'opacity-55' : ''}`}
                    data-search-hit-row
                  >
                    <p className={`text-xs font-medium truncate flex items-center gap-1.5 ${index === boundedCursor ? 'text-accent' : 'text-ink'}`}>
                      <Icon size={12} strokeWidth={1.75} className="text-ink-faint shrink-0" />
                      <span className="truncate flex-1 min-w-0">{title}</span>
                      {match.archived && <Archive size={11} strokeWidth={1.75} className="text-ink-faint shrink-0" />}
                      {match.count > 1 && <span className="text-2xs text-ink-faint font-normal shrink-0">×{match.count}</span>}
                    </p>
                    <p className="text-2xs text-ink-faint mt-0.5 break-all leading-relaxed">
                      {match.matchLen > 0 ? <>
                        {match.snippet.slice(0, match.matchStart)}
                        <mark className="bg-accent/20 text-accent rounded-sm px-px">{match.snippet.slice(match.matchStart, match.matchStart + match.matchLen)}</mark>
                        {match.snippet.slice(match.matchStart + match.matchLen)}
                      </> : match.snippet}
                    </p>
                  </button>
                </li>
              );
            })}
            {matches.length > limit && <li><button onClick={() => setLimit((n) => n + SHOW_LIMIT)} className="px-4 py-2 text-xs text-accent">{t('knowledgeViews.showMore')}</button></li>}
          </ul>
        )}
        {active && matches.length === 0 && (
          <p className="border-t border-line/60 px-4 py-6 text-center text-xs text-ink-faint">{dateInvalid ? t('search.invalidDate') : t('search.noResults')}</p>
        )}
        {!filtersOpen && active && (
          <button onClick={() => setFiltersOpen(true)} className="w-full border-t border-line/60 px-4 py-1.5 text-2xs text-ink-faint hover:text-accent flex items-center justify-center gap-1">
            <ChevronDown size={11} /> {t('search.filters')}
          </button>
        )}
      </div>
    </div>
  );
}
