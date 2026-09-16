import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronRight,
  GitBranch,
  LayoutGrid,
  Network,
  Search,
  X,
} from 'lucide-react';
import { useStore } from '../../store';
import { useProjects } from '../../store/projects';
import { useUiStore } from '../../lib/ui-store';
import {
  groupKnowledgeCardsByTime as groupKnowledgeCards,
  type KnowledgeQueryProjection,
  projectKnowledgeTree as buildKnowledgeTree,
  type CardTimeGroup,
  type KnowledgeGraphInput,
  type KnowledgeTreeItem,
} from '../../lib/knowledge';
import { fmt, useDateLocale, useT } from '../../i18n';
import type { ThoughtNode } from '../../types';
import NodeTaxonomyBadges from './NodeTaxonomyBadges';

type KnowledgeView = 'tree' | 'card';

type KnowledgeViewMessageKey =
  | 'knowledgeViews.showMore'
  | 'knowledgeViews.tree'
  | 'knowledgeViews.card'
  | 'knowledgeViews.switcher'
  | 'knowledgeViews.resultCount'
  | 'knowledgeViews.empty'
  | 'knowledgeViews.backToCanvas'
  | 'knowledgeViews.expand'
  | 'knowledgeViews.collapse'
  | 'knowledgeViews.untitled'
  | 'knowledgeViews.undated'
  | 'knowledgeViews.multiParent'
  | 'knowledgeViews.cycle'
  | 'knowledgeViews.truncated'
  | 'knowledgeViews.jumpCount'
  | 'knowledgeViews.archived'
  | 'knowledgeViews.openNode'
  | 'search.activeOutsideFilter';

type ViewTranslator = (key: KnowledgeViewMessageKey) => string;

export interface KnowledgeViewsProps {
  projection: KnowledgeQueryProjection;
  /** Called after shared selection/active-node state has been updated. */
  onLocate?: (nodeId: string) => void;
  onSearch?: () => void;
}

function oneLine(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function nodeTitle(node: ThoughtNode, untitled: string): string {
  return oneLine(node.data.linkTitle)
    || oneLine(node.data.question)
    || oneLine(node.data.attachments?.[0]?.name)
    || untitled;
}

function nodeExcerpt(node: ThoughtNode, title: string): string {
  if (node.data.editMode === 'manual') return '';
  const index = node.data.responseIndex;
  const summary = node.data.summaries?.[index] ?? node.data.summary;
  const response = node.data.responses[index] ?? node.data.response;
  const question = oneLine(node.data.question);
  return oneLine(summary ?? undefined)
    || oneLine(response)
    || (question !== title ? question : '');
}

function TreeRow({
  item,
  nodesById,
  activeNodeId,
  expandedKeys,
  onToggle,
  onActivate,
  tx,
}: {
  item: KnowledgeTreeItem;
  nodesById: ReadonlyMap<string, ThoughtNode>;
  activeNodeId: string | null;
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onActivate: (nodeId: string) => void;
  tx: ViewTranslator;
}) {
  const node = nodesById.get(item.nodeId);
  if (!node) return null;

  const title = nodeTitle(node, tx('knowledgeViews.untitled'));
  const hasChildren = item.children.length > 0;
  const collapsed = hasChildren && !expandedKeys.has(item.key);
  const active = item.nodeId === activeNodeId;
  const paddingInlineStart = Math.min(item.depth, 12) * 20 + 12;

  return (
    <li
      role="treeitem"
      aria-expanded={hasChildren ? !collapsed : undefined}
      aria-selected={active}
      data-knowledge-tree-key={item.key}
    >
      <div
        className={`group flex min-h-11 items-center gap-1 border-b border-line/50 pr-3 transition-colors ${
          active ? 'bg-accent/10' : 'hover:bg-wash/70'
        }`}
        style={{ paddingInlineStart }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(item.key)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-line/70 hover:text-ink"
            aria-label={tx(collapsed ? 'knowledgeViews.expand' : 'knowledgeViews.collapse')}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : <span className="h-7 w-7 shrink-0" aria-hidden />}

        <button
          type="button"
          onClick={() => onActivate(item.nodeId)}
          title={tx('knowledgeViews.openNode')}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          data-knowledge-node-id={item.nodeId}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-ink-faint/45'}`} />
          <span className={`min-w-0 flex-1 truncate text-sm ${active ? 'font-semibold text-accent' : 'text-ink'}`}>
            {title}
          </span>
          <NodeTaxonomyBadges tagIds={node.data.tagIds} customTypeId={node.data.customTypeId} compact />
          {node.data.archived && (
            <span className="shrink-0 text-ink-faint" title={tx('knowledgeViews.archived')}>
              <Archive size={12} />
              <span className="sr-only">{tx('knowledgeViews.archived')}</span>
            </span>
          )}
          {item.jumpNodeIds.length > 0 && (
            <span className="shrink-0 rounded-full bg-wash px-1.5 py-0.5 text-2xs text-ink-faint">
              {fmt(tx('knowledgeViews.jumpCount'), { n: item.jumpNodeIds.length })}
            </span>
          )}
          {item.multiParent && (
            <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-2xs text-accent">
              {tx('knowledgeViews.multiParent')}
            </span>
          )}
          {item.cycle && (
            <span className="shrink-0 text-warm" title={tx('knowledgeViews.cycle')}>
              <AlertTriangle size={13} />
              <span className="sr-only">{tx('knowledgeViews.cycle')}</span>
            </span>
          )}
          {item.truncated && (
            <span className="shrink-0 text-warm" title={tx('knowledgeViews.truncated')}>
              <AlertTriangle size={13} />
              <span className="sr-only">{tx('knowledgeViews.truncated')}</span>
            </span>
          )}
        </button>
      </div>

      {hasChildren && !collapsed && (
        <ul role="group">
          {item.children.map((child) => (
            <TreeRow
              key={child.key}
              item={child}
              nodesById={nodesById}
              activeNodeId={activeNodeId}
              expandedKeys={expandedKeys}
              onToggle={onToggle}
              onActivate={onActivate}
              tx={tx}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TreeView({
  graph,
  matchedNodeIds,
  nodesById,
  activeNodeId,
  expandedKeys,
  onToggle,
  onActivate,
  tx,
}: {
  graph: KnowledgeGraphInput;
  matchedNodeIds: readonly string[];
  nodesById: ReadonlyMap<string, ThoughtNode>;
  activeNodeId: string | null;
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onActivate: (nodeId: string) => void;
  tx: ViewTranslator;
}) {
  const [limit, setLimit] = useState(100);
  const projection = useMemo(
    () => buildKnowledgeTree(graph, { nodeIds: matchedNodeIds }),
    [graph, matchedNodeIds],
  );

  if (projection.roots.length === 0) {
    return <EmptyView tx={tx} />;
  }

  return (
    <div className="mx-auto w-full max-w-5xl overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
      {projection.truncated && (
        <div className="flex items-center gap-1.5 border-b border-warm/30 bg-warm/10 px-4 py-2 text-xs text-warm">
          <AlertTriangle size={13} /> {tx('knowledgeViews.truncated')}
        </div>
      )}
      <ul role="tree" className="py-1">
        {projection.roots.slice(0, limit).map((root) => (
          <TreeRow
            key={root.key}
            item={root}
            nodesById={nodesById}
            activeNodeId={activeNodeId}
            expandedKeys={expandedKeys}
            onToggle={onToggle}
            onActivate={onActivate}
            tx={tx}
          />
        ))}
      </ul>
      {projection.roots.length > limit && <button className="m-3 text-sm text-accent" onClick={() => setLimit((n) => n + 100)}>{tx('knowledgeViews.showMore')}</button>}
    </div>
  );
}

function formatCardGroup(group: CardTimeGroup, locale: string, undated: string): string {
  if (group.key === 'undated') return undated;
  const timestamp = Date.parse(`${group.key}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return group.key;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(timestamp);
}

function CardView({
  graph,
  matchedNodeIds,
  nodesById,
  activeNodeId,
  onActivate,
  tx,
}: {
  graph: KnowledgeGraphInput;
  matchedNodeIds: readonly string[];
  nodesById: ReadonlyMap<string, ThoughtNode>;
  activeNodeId: string | null;
  onActivate: (nodeId: string) => void;
  tx: ViewTranslator;
}) {
  const locale = useDateLocale();
  const [limit, setLimit] = useState(100);
  const groups = useMemo(
    () => groupKnowledgeCards(graph, { nodeIds: matchedNodeIds }),
    [graph, matchedNodeIds],
  );

  const visibleIds = new Set(groups.flatMap((group) => group.nodeIds).slice(0, limit));

  if (groups.length === 0) {
    return <EmptyView tx={tx} />;
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7">
      {groups.filter((group) => group.nodeIds.some((id) => visibleIds.has(id))).map((group) => (
        <section key={group.key}>
          <header className="mb-2 flex items-center gap-2 px-1">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
              {formatCardGroup(group, locale, tx('knowledgeViews.undated'))}
            </h3>
            <span className="text-2xs text-ink-faint">
              {fmt(tx('knowledgeViews.resultCount'), { n: group.nodeIds.length })}
            </span>
          </header>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {group.nodeIds.filter((id) => visibleIds.has(id)).map((nodeId) => {
              const node = nodesById.get(nodeId);
              if (!node) return null;
              const title = nodeTitle(node, tx('knowledgeViews.untitled'));
              const excerpt = nodeExcerpt(node, title);
              const active = nodeId === activeNodeId;
              return (
                <button
                  key={nodeId}
                  type="button"
                  onClick={() => onActivate(nodeId)}
                  title={tx('knowledgeViews.openNode')}
                  aria-current={active ? 'true' : undefined}
                  className={`flex min-h-[132px] flex-col rounded-xl border p-4 text-left shadow-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                    active
                      ? 'border-accent bg-accent/10 shadow-md'
                      : 'border-line bg-card hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md'
                  }`}
                  data-knowledge-node-id={nodeId}
                >
                  <span className="flex w-full min-w-0 items-start gap-2">
                    <span className={`min-w-0 flex-1 text-sm font-semibold leading-snug ${active ? 'text-accent' : 'text-ink'}`}>
                      {title}
                    </span>
                    {node.data.archived && (
                      <span className="shrink-0 text-ink-faint" title={tx('knowledgeViews.archived')}>
                        <Archive size={13} />
                        <span className="sr-only">{tx('knowledgeViews.archived')}</span>
                      </span>
                    )}
                  </span>
                  {excerpt && (
                    <span className="mt-2 max-h-[4.5rem] overflow-hidden text-xs leading-relaxed text-ink-muted">
                      {excerpt}
                    </span>
                  )}
                  <span className="mt-auto pt-3">
                    <NodeTaxonomyBadges tagIds={node.data.tagIds} customTypeId={node.data.customTypeId} />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {matchedNodeIds.length > limit && <button className="text-sm text-accent" onClick={() => setLimit((n) => n + 100)}>{tx('knowledgeViews.showMore')}</button>}
    </div>
  );
}

function EmptyView({ tx }: { tx: ViewTranslator }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center text-ink-faint">
      <Network size={28} strokeWidth={1.5} />
      <p className="text-sm">{tx('knowledgeViews.empty')}</p>
    </div>
  );
}

function KnowledgeViewsOverlay({ view, onLocate, onSearch, projection: queryProjection }: KnowledgeViewsProps & { view: KnowledgeView }) {
  const rawT = useT();
  const tx: ViewTranslator = (key) => rawT(key as Parameters<typeof rawT>[0]);
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const organizationRelations = useStore((state) => state.organizationRelations);
  const activeNodeId = useUiStore((state) => state.activeNodeId);
  const setCanvasView = useUiStore((state) => state.setCanvasView);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());

  const graph = useMemo<KnowledgeGraphInput>(
    () => ({ nodes, edges, organizationRelations }),
    [edges, nodes, organizationRelations],
  );
  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const onToggle = useCallback((key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const onActivate = useCallback((nodeId: string) => {
    useStore.getState().setSelectedNodeId(nodeId);
    useUiStore.getState().setActiveNodeId(nodeId);
    onLocate?.(nodeId);
  }, [onLocate]);

  return (
    <section
      className="absolute inset-0 z-20 flex flex-col overflow-hidden bg-surface/95 backdrop-blur-sm"
      data-knowledge-views
      data-canvas-view={view}
      aria-labelledby="knowledge-views-title"
    >
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-card/90 px-5 shadow-sm">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            {view === 'tree' ? <GitBranch size={17} /> : <LayoutGrid size={17} />}
          </span>
          <div className="min-w-0">
            <h2 id="knowledge-views-title" className="truncate text-sm font-semibold text-ink">
              {tx(view === 'tree' ? 'knowledgeViews.tree' : 'knowledgeViews.card')}
            </h2>
            <p className="text-2xs text-ink-faint">
              {fmt(tx('knowledgeViews.resultCount'), { n: queryProjection.matchedNodeIds.length })}
            </p>
          </div>
        </div>

        <nav
          className="flex items-center rounded-lg border border-line bg-wash p-0.5"
          aria-label={tx('knowledgeViews.switcher')}
        >
          <button
            type="button"
            onClick={() => setCanvasView('tree')}
            aria-pressed={view === 'tree'}
            className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs transition-colors ${
              view === 'tree' ? 'bg-card font-medium text-accent shadow-sm' : 'text-ink-muted hover:text-ink'
            }`}
          >
            <GitBranch size={13} /> {tx('knowledgeViews.tree')}
          </button>
          <button
            type="button"
            onClick={() => setCanvasView('card')}
            aria-pressed={view === 'card'}
            className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs transition-colors ${
              view === 'card' ? 'bg-card font-medium text-accent shadow-sm' : 'text-ink-muted hover:text-ink'
            }`}
          >
            <LayoutGrid size={13} /> {tx('knowledgeViews.card')}
          </button>
        </nav>

        {onSearch && (
          <button
            type="button"
            onClick={onSearch}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-wash hover:text-accent"
            aria-label={rawT('search.entryTitle')}
            title={rawT('search.entryTitle')}
          >
            <Search size={16} strokeWidth={1.75} />
          </button>
        )}

        <button
          type="button"
          onClick={() => setCanvasView('canvas')}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-wash hover:text-ink"
          aria-label={tx('knowledgeViews.backToCanvas')}
          title={tx('knowledgeViews.backToCanvas')}
        >
          <X size={17} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5 md:p-7">
        {queryProjection.activeOutsideFilter && (
          <div className="mx-auto mb-3 w-full max-w-7xl rounded-lg border border-warm/30 bg-warm/10 px-3 py-2 text-xs text-warm" data-active-outside-filter>
            {tx('search.activeOutsideFilter')}
          </div>
        )}
        {view === 'tree' ? (
          <TreeView
            graph={graph}
            matchedNodeIds={queryProjection.visibleNodeIds}
            nodesById={nodesById}
            activeNodeId={activeNodeId}
            expandedKeys={expandedKeys}
            onToggle={onToggle}
            onActivate={onActivate}
            tx={tx}
          />
        ) : (
          <CardView
            graph={graph}
            matchedNodeIds={queryProjection.visibleNodeIds}
            nodesById={nodesById}
            activeNodeId={activeNodeId}
            onActivate={onActivate}
            tx={tx}
          />
        )}
      </div>
    </section>
  );
}

export default function KnowledgeViews(props: KnowledgeViewsProps) {
  const canvasView = useUiStore((state) => state.canvasView);
  const projectId = useProjects(state => state.activeId);
  if (canvasView === 'canvas') return null;
  return <KnowledgeViewsOverlay key={projectId} {...props} view={canvasView} />;
}
