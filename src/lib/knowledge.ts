import type { OrganizationRelation, ThoughtData, ThoughtEdge, ThoughtNode } from '../types';

/** Pure knowledge-graph projections. Nothing in this module mutates graph data
 *  or changes which content reaches the model. ThoughtEdge stays the executable
 *  context graph; OrganizationRelation is a separate navigation graph. */

export interface KnowledgeGraphInput {
  nodes: readonly ThoughtNode[];
  edges?: readonly ThoughtEdge[];
  organizationRelations?: readonly OrganizationRelation[];
}

export type SystemNodeKind = 'qa' | NonNullable<ThoughtData['stepKind']>;
export type ArchivedFilter = 'any' | 'active' | 'archived';
export type TagMatch = 'all' | 'any';
export type RelationScope = 'all' | 'ancestors' | 'descendants' | 'branch' | 'backlinks' | 'orphans';
export type RelationDomain = 'context' | 'organization' | 'combined';

export interface CreatedAtFilter {
  /** Inclusive ISO timestamp or YYYY-MM-DD (interpreted as UTC day start). */
  from?: string;
  /** Inclusive ISO timestamp or YYYY-MM-DD (interpreted as UTC day end). */
  to?: string;
}

export interface RelationScopeFilter {
  scope: RelationScope;
  /** Required except for `all` and `orphans`. A missing/unknown anchor matches nothing. */
  anchorNodeId?: string;
  /** Which directed hierarchy ancestors/descendants/branch traverse. Defaults to combined. */
  domain?: RelationDomain;
}

export interface KnowledgeQuery {
  /** Case-insensitive exact substring. Optional: metadata-only filtering is supported. */
  text?: string;
  /** OR within this dimension; dimensions are combined with AND. `qa` means no stepKind. */
  systemKinds?: readonly SystemNodeKind[];
  /** OR within this dimension. */
  customTypeIds?: readonly string[];
  /** All selected tags by default; set tagMatch='any' for OR within this dimension. */
  tagIds?: readonly string[];
  tagMatch?: TagMatch;
  createdAt?: CreatedAtFilter;
  archived?: ArchivedFilter;
  relation?: RelationScopeFilter;
}

export type SearchField =
  | 'question'
  | 'response'
  | 'highlight'
  | 'link'
  | 'attachment-name'
  | 'attachment-text'
  | 'summary';

export interface KnowledgeQueryHit {
  nodeId: string;
  /** Empty for filter-only queries. */
  matchedFields: SearchField[];
  /** Total substring occurrences across all searchable values. */
  occurrenceCount: number;
}

export interface KnowledgeQueryResult {
  nodeIds: string[];
  hits: KnowledgeQueryHit[];
}

export interface KnowledgeProjectionOptions {
  activeNodeId?: string | null;
  localDepth?: 0 | 1 | 2;
}

export interface KnowledgeQueryProjection {
  /** Nodes admitted by the full graph or active-node neighborhood. */
  candidateNodeIds: string[];
  /** Query matches inside the candidate set; the out-of-filter anchor is excluded. */
  matchedNodeIds: string[];
  /** Matches plus the active anchor when local filtering would otherwise remove it. */
  visibleNodeIds: string[];
  hits: KnowledgeQueryHit[];
  activeOutsideFilter: boolean;
  neighborhood: ActiveNeighborhoodProjection | null;
}

export type LocalNeighborRole =
  | 'active'
  | 'upstream'
  | 'downstream'
  | 'reference'
  | 'organization-parent'
  | 'organization-child'
  | 'jump'
  | 'sibling'
  | 'extended';

export interface ActiveNeighborhoodProjection {
  activeNodeId: string;
  depth: 1 | 2;
  nodeIds: string[];
  contextEdgeIds: string[];
  organizationRelationIds: string[];
  distanceByNodeId: Record<string, number>;
  /** Direct roles are relative to the active node; depth-two-only nodes are `extended`. */
  rolesByNodeId: Record<string, LocalNeighborRole[]>;
}

export type OrganizationRelationCheckReason = 'self-loop' | 'duplicate' | 'parent-cycle';

export interface OrganizationRelationCheck {
  ok: boolean;
  reason?: OrganizationRelationCheckReason;
  /** Closed path, e.g. A → B → C → A. Present for parent-cycle. */
  cyclePath?: string[];
}

export type OrganizationRelationDraft = Pick<OrganizationRelation, 'sourceId' | 'targetId' | 'kind'>
  & Partial<Pick<OrganizationRelation, 'id' | 'createdAt'>>;

export interface KnowledgeTreeItem {
  /** Path-specific key: a multi-parent node has one item per parent path. */
  key: string;
  nodeId: string;
  parentNodeId: string | null;
  viaRelationId?: string;
  depth: number;
  multiParent: boolean;
  /** A terminal occurrence whose next edge returns to an ancestor in this path. */
  cycle: boolean;
  /** Expansion stopped because maxDepth/maxItems was reached. */
  truncated: boolean;
  jumpNodeIds: string[];
  children: KnowledgeTreeItem[];
}

export interface KnowledgeTreeOptions {
  /** Optional result set from queryKnowledgeNodes. */
  nodeIds?: readonly string[];
  /** Safety bounds for malformed or path-explosive imported graphs. */
  maxDepth?: number;
  maxItems?: number;
}

export interface KnowledgeTreeProjection {
  roots: KnowledgeTreeItem[];
  cycleRelationIds: string[];
  /** True when safety bounds stopped at least one branch. */
  truncated: boolean;
}

export type CardTimeGranularity = 'day' | 'month' | 'year';

export interface CardTimeGroup {
  /** UTC YYYY-MM-DD / YYYY-MM / YYYY, or `undated`. */
  key: string;
  nodeIds: string[];
  newestAt?: string;
  oldestAt?: string;
}

export interface CardTimeOptions {
  granularity?: CardTimeGranularity;
  /** Optional result set from queryKnowledgeNodes. */
  nodeIds?: readonly string[];
  /** Defaults to newest first; undated is always last. */
  direction?: 'newest' | 'oldest';
}

const ROLE_ORDER: readonly LocalNeighborRole[] = [
  'active',
  'upstream',
  'downstream',
  'reference',
  'organization-parent',
  'organization-child',
  'jump',
  'sibling',
  'extended',
];

function contextEdgesOf(graph: KnowledgeGraphInput): ThoughtEdge[] {
  return (graph.edges ?? []).filter((edge) => !edge.data?.isOrganization);
}

function structuralEdgesOf(graph: KnowledgeGraphInput): ThoughtEdge[] {
  return contextEdgesOf(graph).filter((edge) => !edge.data?.isCrossLink);
}

function referenceEdgesOf(graph: KnowledgeGraphInput): ThoughtEdge[] {
  return contextEdgesOf(graph).filter((edge) => !!edge.data?.isCrossLink);
}

function relationsOf(graph: KnowledgeGraphInput): OrganizationRelation[] {
  return [...(graph.organizationRelations ?? [])];
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key);
  if (values) values.add(value);
  else map.set(key, new Set([value]));
}

function addRole(map: Map<string, Set<LocalNeighborRole>>, nodeId: string, role: LocalNeighborRole): void {
  const roles = map.get(nodeId);
  if (roles) roles.add(role);
  else map.set(nodeId, new Set([role]));
}

function pathBetween(
  startId: string,
  goalId: string,
  relations: readonly OrganizationRelation[],
): string[] | null {
  if (startId === goalId) return [startId];
  const children = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.kind !== 'parent') continue;
    const list = children.get(relation.sourceId);
    if (list) list.push(relation.targetId);
    else children.set(relation.sourceId, [relation.targetId]);
  }
  const queue = [startId];
  const previous = new Map<string, string | null>([[startId, null]]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of children.get(current) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      if (next === goalId) {
        const path: string[] = [];
        let cursor: string | null = next;
        while (cursor != null) {
          path.push(cursor);
          cursor = previous.get(cursor) ?? null;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

/** Validate one organization relation before insertion/update. Parent relations
 *  stay acyclic; jump relations are non-hierarchical and may close larger loops.
 *  Self-jumps and same-direction duplicates are rejected; reverse jumps remain valid. */
export function checkOrganizationRelation(
  existing: readonly OrganizationRelation[],
  candidate: OrganizationRelationDraft,
): OrganizationRelationCheck {
  if (candidate.sourceId === candidate.targetId) return { ok: false, reason: 'self-loop' };
  const others = candidate.id ? existing.filter((relation) => relation.id !== candidate.id) : [...existing];
  const duplicate = others.some((relation) => {
    if (relation.kind !== candidate.kind) return false;
    if (candidate.kind === 'parent') {
      return relation.sourceId === candidate.sourceId && relation.targetId === candidate.targetId;
    }
    return relation.sourceId === candidate.sourceId && relation.targetId === candidate.targetId;
  });
  if (duplicate) return { ok: false, reason: 'duplicate' };
  if (candidate.kind === 'jump') return { ok: true };
  const path = pathBetween(candidate.targetId, candidate.sourceId, others);
  return path
    ? { ok: false, reason: 'parent-cycle', cyclePath: [candidate.sourceId, ...path] }
    : { ok: true };
}

/** Find cycles already present in imported parent relations. Each returned path
 *  is closed (first node repeated last). Jump relations are intentionally ignored. */
export function findParentCycles(relations: readonly OrganizationRelation[]): string[][] {
  const children = new Map<string, string[]>();
  const nodeIds = new Set<string>();
  for (const relation of relations) {
    if (relation.kind !== 'parent') continue;
    nodeIds.add(relation.sourceId);
    nodeIds.add(relation.targetId);
    const list = children.get(relation.sourceId);
    if (list) list.push(relation.targetId);
    else children.set(relation.sourceId, [relation.targetId]);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const canonicalKey = (cycle: string[]) => {
    const open = cycle.slice(0, -1);
    const rotations = open.map((_, index) => [...open.slice(index), ...open.slice(0, index)]);
    const best = rotations.map((rotation) => rotation.join('\u0000')).sort()[0] ?? '';
    return best;
  };
  const visit = (nodeId: string) => {
    color.set(nodeId, 1);
    stackIndex.set(nodeId, stack.length);
    stack.push(nodeId);
    for (const childId of children.get(nodeId) ?? []) {
      if (color.get(childId) === 1) {
        const start = stackIndex.get(childId)!;
        const cycle = [...stack.slice(start), childId];
        const key = canonicalKey(cycle);
        if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
      } else if ((color.get(childId) ?? 0) === 0) {
        visit(childId);
      }
    }
    stack.pop();
    stackIndex.delete(nodeId);
    color.set(nodeId, 2);
  };
  for (const nodeId of nodeIds) if ((color.get(nodeId) ?? 0) === 0) visit(nodeId);
  return cycles;
}

interface NeighborhoodIndex {
  upstream: Map<string, Set<string>>;
  downstream: Map<string, Set<string>>;
  references: Map<string, Set<string>>;
  organizationParents: Map<string, Set<string>>;
  organizationChildren: Map<string, Set<string>>;
  jumps: Map<string, Set<string>>;
  childrenByParent: Map<string, Set<string>>;
  parentsByChild: Map<string, Set<string>>;
}

function buildNeighborhoodIndex(graph: KnowledgeGraphInput, validNodeIds: ReadonlySet<string>): NeighborhoodIndex {
  const upstream = new Map<string, Set<string>>();
  const downstream = new Map<string, Set<string>>();
  const references = new Map<string, Set<string>>();
  const organizationParents = new Map<string, Set<string>>();
  const organizationChildren = new Map<string, Set<string>>();
  const jumps = new Map<string, Set<string>>();
  const childrenByParent = new Map<string, Set<string>>();
  const parentsByChild = new Map<string, Set<string>>();
  for (const edge of structuralEdgesOf(graph)) {
    if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) continue;
    addToSetMap(upstream, edge.target, edge.source);
    addToSetMap(downstream, edge.source, edge.target);
    addToSetMap(childrenByParent, edge.source, edge.target);
    addToSetMap(parentsByChild, edge.target, edge.source);
  }
  for (const edge of referenceEdgesOf(graph)) {
    if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) continue;
    addToSetMap(references, edge.source, edge.target);
    addToSetMap(references, edge.target, edge.source);
  }
  for (const relation of relationsOf(graph)) {
    if (!validNodeIds.has(relation.sourceId) || !validNodeIds.has(relation.targetId)) continue;
    if (relation.kind === 'parent') {
      addToSetMap(organizationParents, relation.targetId, relation.sourceId);
      addToSetMap(organizationChildren, relation.sourceId, relation.targetId);
      addToSetMap(childrenByParent, relation.sourceId, relation.targetId);
      addToSetMap(parentsByChild, relation.targetId, relation.sourceId);
    } else {
      addToSetMap(jumps, relation.sourceId, relation.targetId);
      addToSetMap(jumps, relation.targetId, relation.sourceId);
    }
  }
  return { upstream, downstream, references, organizationParents, organizationChildren, jumps, childrenByParent, parentsByChild };
}

function siblingIds(index: NeighborhoodIndex, nodeId: string): Set<string> {
  const siblings = new Set<string>();
  for (const parentId of index.parentsByChild.get(nodeId) ?? []) {
    for (const childId of index.childrenByParent.get(parentId) ?? []) {
      if (childId !== nodeId) siblings.add(childId);
    }
  }
  return siblings;
}

function hierarchyNeighborIds(index: NeighborhoodIndex, nodeId: string): Set<string> {
  const result = new Set<string>();
  for (const map of [
    index.upstream,
    index.downstream,
    index.organizationParents,
    index.organizationChildren,
  ]) {
    for (const id of map.get(nodeId) ?? []) result.add(id);
  }
  return result;
}

/** Derive the induced one/two-layer graph around an active node. */
export function projectActiveNeighborhood(
  graph: KnowledgeGraphInput,
  activeNodeId: string,
  depth: 1 | 2 = 1,
): ActiveNeighborhoodProjection {
  const validNodeIds = new Set(graph.nodes.map((node) => node.id));
  if (!validNodeIds.has(activeNodeId)) {
    return {
      activeNodeId,
      depth,
      nodeIds: [],
      contextEdgeIds: [],
      organizationRelationIds: [],
      distanceByNodeId: {},
      rolesByNodeId: {},
    };
  }
  const index = buildNeighborhoodIndex(graph, validNodeIds);
  const distances = new Map<string, number>([[activeNodeId, 0]]);
  const roles = new Map<string, Set<LocalNeighborRole>>();
  addRole(roles, activeNodeId, 'active');
  const directMaps: [Map<string, Set<string>>, LocalNeighborRole][] = [
    [index.upstream, 'upstream'],
    [index.downstream, 'downstream'],
    [index.references, 'reference'],
    [index.organizationParents, 'organization-parent'],
    [index.organizationChildren, 'organization-child'],
    [index.jumps, 'jump'],
  ];
  for (const [map, role] of directMaps) {
    for (const nodeId of map.get(activeNodeId) ?? []) {
      distances.set(nodeId, 1);
      addRole(roles, nodeId, role);
    }
  }
  for (const nodeId of siblingIds(index, activeNodeId)) {
    distances.set(nodeId, 1);
    addRole(roles, nodeId, 'sibling');
  }
  if (depth === 2) {
    // Depth expands hierarchy only. References, jumps and siblings stay
    // direct navigation neighbors and never turn into accidental portals to
    // an unrelated second neighborhood.
    const frontier = new Set<string>();
    for (const map of [index.upstream, index.downstream, index.organizationParents, index.organizationChildren]) {
      for (const nodeId of map.get(activeNodeId) ?? []) frontier.add(nodeId);
    }
    for (const nodeId of frontier) {
      for (const neighborId of hierarchyNeighborIds(index, nodeId)) {
        if (distances.has(neighborId)) continue;
        distances.set(neighborId, 2);
        addRole(roles, neighborId, 'extended');
      }
    }
  }
  const included = new Set(distances.keys());
  const nodeIds = graph.nodes.filter((node) => included.has(node.id)).map((node) => node.id);
  const contextEdgeIds = contextEdgesOf(graph)
    .filter((edge) => included.has(edge.source) && included.has(edge.target))
    .map((edge) => edge.id);
  const organizationRelationIds = relationsOf(graph)
    .filter((relation) => included.has(relation.sourceId) && included.has(relation.targetId))
    .map((relation) => relation.id);
  const distanceByNodeId = Object.fromEntries(nodeIds.map((nodeId) => [nodeId, distances.get(nodeId)!]));
  const rolesByNodeId = Object.fromEntries(nodeIds.map((nodeId) => {
    const nodeRoles = [...(roles.get(nodeId) ?? new Set<LocalNeighborRole>(['extended']))]
      .sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
    return [nodeId, nodeRoles];
  }));
  return { activeNodeId, depth, nodeIds, contextEdgeIds, organizationRelationIds, distanceByNodeId, rolesByNodeId };
}

function directedHierarchy(
  graph: KnowledgeGraphInput,
  domain: RelationDomain,
  validNodeIds: ReadonlySet<string>,
): { parents: Map<string, Set<string>>; children: Map<string, Set<string>> } {
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  if (domain !== 'organization') {
    for (const edge of structuralEdgesOf(graph)) {
      if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) continue;
      addToSetMap(parents, edge.target, edge.source);
      addToSetMap(children, edge.source, edge.target);
    }
  }
  if (domain !== 'context') {
    for (const relation of relationsOf(graph)) {
      if (relation.kind !== 'parent' || !validNodeIds.has(relation.sourceId) || !validNodeIds.has(relation.targetId)) continue;
      addToSetMap(parents, relation.targetId, relation.sourceId);
      addToSetMap(children, relation.sourceId, relation.targetId);
    }
  }
  return { parents, children };
}

function traverse(startId: string, adjacency: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const found = new Set<string>();
  const queue = [...(adjacency.get(startId) ?? [])];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (found.has(nodeId) || nodeId === startId) continue;
    found.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) if (!found.has(next)) queue.push(next);
  }
  return found;
}

function relationScopeIds(graph: KnowledgeGraphInput, filter?: RelationScopeFilter): Set<string> | null {
  if (!filter || filter.scope === 'all') return null;
  const validNodeIds = new Set(graph.nodes.map((node) => node.id));
  const domain = filter.domain ?? 'combined';
  if (filter.scope === 'orphans') {
    const connected = new Set<string>();
    if (domain !== 'organization') {
      for (const edge of contextEdgesOf(graph)) {
        if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) continue;
        connected.add(edge.source);
        connected.add(edge.target);
      }
    }
    if (domain !== 'context') {
      for (const relation of relationsOf(graph)) {
        if (!validNodeIds.has(relation.sourceId) || !validNodeIds.has(relation.targetId)) continue;
        connected.add(relation.sourceId);
        connected.add(relation.targetId);
      }
    }
    return new Set([...validNodeIds].filter((nodeId) => !connected.has(nodeId)));
  }
  const anchor = filter.anchorNodeId;
  if (!anchor || !validNodeIds.has(anchor)) return new Set();
  const { parents, children } = directedHierarchy(graph, domain, validNodeIds);
  if (filter.scope === 'ancestors') return traverse(anchor, parents);
  if (filter.scope === 'descendants') return traverse(anchor, children);
  if (filter.scope === 'branch') {
    return new Set([anchor, ...traverse(anchor, parents), ...traverse(anchor, children)]);
  }
  const backlinks = new Set<string>();
  if (domain !== 'organization') {
    for (const edge of contextEdgesOf(graph)) {
      if (edge.data?.isCrossLink && edge.target === anchor && validNodeIds.has(edge.source)) backlinks.add(edge.source);
    }
  }
  if (domain !== 'context') {
    for (const relation of relationsOf(graph)) {
      if (!validNodeIds.has(relation.sourceId) || !validNodeIds.has(relation.targetId)) continue;
      if (relation.kind === 'parent' && relation.targetId === anchor) backlinks.add(relation.sourceId);
      if (relation.kind === 'jump' && relation.targetId === anchor) backlinks.add(relation.sourceId);
    }
  }
  return backlinks;
}

function parseBoundary(value: string, endOfDay: boolean): number {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const time = Date.parse(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  if (!Number.isFinite(time)) throw new RangeError(`Invalid date boundary: ${value}`);
  return time;
}

function countOccurrences(text: string, query: string): number {
  let count = 0;
  let index = text.indexOf(query);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(query, index + query.length);
  }
  return count;
}

function searchableValues(node: ThoughtNode): [SearchField, string][] {
  const values: [SearchField, string][] = [];
  const seen = new Set<string>();
  const add = (field: SearchField, value?: string | null) => {
    if (!value) return;
    const key = `${field}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    values.push([field, value]);
  };
  add('question', node.data.question);
  add('response', node.data.response);
  for (const highlight of node.data.highlights ?? []) add('highlight', highlight.text);
  add('link', node.data.linkTitle);
  for (const attachment of node.data.attachments ?? []) {
    add('attachment-name', attachment.name);
  }
  add('summary', node.data.summaries?.[node.data.responseIndex] ?? node.data.summary);
  return values;
}

export function knowledgeQueryIsActive(query: KnowledgeQuery = {}): boolean {
  return !!(
    query.text?.trim()
    || query.systemKinds?.length
    || query.customTypeIds?.length
    || query.tagIds?.length
    || query.createdAt?.from
    || query.createdAt?.to
    || (query.archived && query.archived !== 'any')
    || (query.relation && query.relation.scope !== 'all')
  );
}

/** Resolve the implicit relation anchor shared by every knowledge view. Keeping
 *  this out of individual components prevents Canvas, Search, Tree and Card
 *  from interpreting the same persisted query differently. */
export function resolveKnowledgeQuery(
  query: KnowledgeQuery = {},
  activeNodeId?: string | null,
): KnowledgeQuery {
  if (!query.relation || query.relation.scope === 'all') return query;
  return {
    ...query,
    relation: { ...query.relation, anchorNodeId: activeNodeId ?? undefined },
  };
}

/** Apply every supplied filter with AND semantics. Empty text is not special:
 *  metadata-only and relation-only queries return matching nodes. */
export function queryKnowledgeNodes(
  graph: KnowledgeGraphInput,
  query: KnowledgeQuery = {},
): KnowledgeQueryResult {
  const text = query.text?.trim().toLowerCase() ?? '';
  const kinds = new Set(query.systemKinds ?? []);
  const customTypes = new Set(query.customTypeIds ?? []);
  const tags = new Set(query.tagIds ?? []);
  const from = query.createdAt?.from ? parseBoundary(query.createdAt.from, false) : undefined;
  const to = query.createdAt?.to ? parseBoundary(query.createdAt.to, true) : undefined;
  if (from != null && to != null && from > to) throw new RangeError('createdAt.from must be before createdAt.to');
  const scopeIds = relationScopeIds(graph, query.relation);
  const archived = query.archived ?? 'any';
  const indexed = graph.nodes.map((node, index) => ({ node, index }));
  const hits: (KnowledgeQueryHit & { index: number })[] = [];
  for (const { node, index } of indexed) {
    if (scopeIds && !scopeIds.has(node.id)) continue;
    if (archived === 'active' && node.data.archived) continue;
    if (archived === 'archived' && !node.data.archived) continue;
    if (kinds.size > 0 && !kinds.has(node.data.stepKind ?? 'qa')) continue;
    if (customTypes.size > 0 && (!node.data.customTypeId || !customTypes.has(node.data.customTypeId))) continue;
    if (tags.size > 0) {
      const nodeTags = new Set(node.data.tagIds ?? []);
      const tagMatch = query.tagMatch === 'any'
        ? [...tags].some((tagId) => nodeTags.has(tagId))
        : [...tags].every((tagId) => nodeTags.has(tagId));
      if (!tagMatch) continue;
    }
    if (from != null || to != null) {
      const created = node.data.createdAt ? Date.parse(node.data.createdAt) : Number.NaN;
      if (!Number.isFinite(created) || (from != null && created < from) || (to != null && created > to)) continue;
    }
    let occurrenceCount = 0;
    const matchedFields = new Set<SearchField>();
    if (text) {
      for (const [field, raw] of searchableValues(node)) {
        const count = countOccurrences(raw.toLowerCase(), text);
        if (count === 0) continue;
        occurrenceCount += count;
        matchedFields.add(field);
      }
      if (occurrenceCount === 0) continue;
    }
    hits.push({ nodeId: node.id, matchedFields: [...matchedFields], occurrenceCount, index });
  }
  hits.sort((a, b) => (text ? b.occurrenceCount - a.occurrenceCount : 0) || a.nodeId.localeCompare(b.nodeId));
  return {
    nodeIds: hits.map((hit) => hit.nodeId),
    hits: hits.map((hit) => ({
      nodeId: hit.nodeId,
      matchedFields: hit.matchedFields,
      occurrenceCount: hit.occurrenceCount,
    })),
  };
}

/** One projection shared by Canvas, Search, Tree and Card. Relation traversal
 *  still sees the whole graph, then the result is intersected with the active
 *  neighborhood. An active local anchor survives filtering without becoming a
 *  match, so counts and result lists stay honest. */
export function projectKnowledgeQuery(
  graph: KnowledgeGraphInput,
  query: KnowledgeQuery = {},
  options: KnowledgeProjectionOptions = {},
): KnowledgeQueryProjection {
  const depth = options.localDepth ?? 0;
  const activeNodeId = options.activeNodeId ?? null;
  const neighborhood = (depth === 1 || depth === 2) && activeNodeId
    ? projectActiveNeighborhood(graph, activeNodeId, depth)
    : null;
  const candidateNodeIds = depth > 0
    ? (neighborhood?.nodeIds ?? [])
    : graph.nodes.map((node) => node.id);
  const candidates = new Set(candidateNodeIds);
  const result = queryKnowledgeNodes(graph, query);
  const hits = result.hits.filter((hit) => candidates.has(hit.nodeId));
  const matchedNodeIds = hits.map((hit) => hit.nodeId);
  const activeOutsideFilter = depth > 0
    && knowledgeQueryIsActive(query)
    && !!activeNodeId
    && candidates.has(activeNodeId)
    && !matchedNodeIds.includes(activeNodeId);
  const visible = new Set(matchedNodeIds);
  if (activeOutsideFilter && activeNodeId) visible.add(activeNodeId);
  const visibleNodeIds = graph.nodes.filter((node) => visible.has(node.id)).map((node) => node.id);
  return {
    candidateNodeIds,
    matchedNodeIds,
    visibleNodeIds,
    hits,
    activeOutsideFilter,
    neighborhood,
  };
}

function selectedNodes(graph: KnowledgeGraphInput, ids?: readonly string[]): ThoughtNode[] {
  if (!ids) return [...graph.nodes];
  const selected = new Set(ids);
  return graph.nodes.filter((node) => selected.has(node.id));
}

/** Project organization parent relations into a tree. Nodes with multiple
 *  parents appear once under every path. Imported cycles become terminal cycle
 *  items; rootless cyclic components receive a deterministic synthetic root. */
export function projectKnowledgeTree(
  graph: KnowledgeGraphInput,
  options: KnowledgeTreeOptions = {},
): KnowledgeTreeProjection {
  const nodes = selectedNodes(graph, options.nodeIds);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const parentRelations = relationsOf(graph).filter((relation) =>
    relation.kind === 'parent' && nodeIds.has(relation.sourceId) && nodeIds.has(relation.targetId)
  );
  const relationOrder = (a: OrganizationRelation, b: OrganizationRelation) =>
    (nodeOrder.get(a.targetId)! - nodeOrder.get(b.targetId)!)
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id);
  const children = new Map<string, OrganizationRelation[]>();
  const incoming = new Map<string, OrganizationRelation[]>();
  for (const relation of parentRelations) {
    const childList = children.get(relation.sourceId);
    if (childList) childList.push(relation);
    else children.set(relation.sourceId, [relation]);
    const parentList = incoming.get(relation.targetId);
    if (parentList) parentList.push(relation);
    else incoming.set(relation.targetId, [relation]);
  }
  for (const list of children.values()) list.sort(relationOrder);
  const jumps = new Map<string, Set<string>>();
  for (const relation of relationsOf(graph)) {
    if (relation.kind !== 'jump' || !nodeIds.has(relation.sourceId) || !nodeIds.has(relation.targetId)) continue;
    addToSetMap(jumps, relation.sourceId, relation.targetId);
    addToSetMap(jumps, relation.targetId, relation.sourceId);
  }
  const maxDepth = Math.max(0, options.maxDepth ?? Math.max(nodes.length, 1));
  const maxItems = Math.max(1, options.maxItems ?? 20_000);
  const covered = new Set<string>();
  const cycleRelationIds = new Set<string>();
  let itemCount = 0;
  let projectionTruncated = false;
  const expand = (
    nodeId: string,
    parentNodeId: string | null,
    viaRelationId: string | undefined,
    depth: number,
    path: readonly string[],
    relationPath: readonly string[],
  ): KnowledgeTreeItem => {
    itemCount += 1;
    covered.add(nodeId);
    const cycle = path.includes(nodeId);
    if (cycle && viaRelationId) cycleRelationIds.add(viaRelationId);
    const childRelations = children.get(nodeId) ?? [];
    const bounded = itemCount >= maxItems || depth >= maxDepth;
    if (bounded && childRelations.length > 0) projectionTruncated = true;
    const key = relationPath.length > 0 ? `${path[0]}:${relationPath.join('/')}:${nodeId}` : `root:${nodeId}`;
    const item: KnowledgeTreeItem = {
      key,
      nodeId,
      parentNodeId,
      ...(viaRelationId ? { viaRelationId } : {}),
      depth,
      multiParent: (incoming.get(nodeId)?.length ?? 0) > 1,
      cycle,
      truncated: !cycle && bounded && childRelations.length > 0,
      jumpNodeIds: [...(jumps.get(nodeId) ?? [])].sort((a, b) => (nodeOrder.get(a)! - nodeOrder.get(b)!)),
      children: [],
    };
    if (cycle || bounded) return item;
    const nextPath = [...path, nodeId];
    for (const relation of childRelations) {
      if (itemCount >= maxItems) { projectionTruncated = true; item.truncated = true; break; }
      item.children.push(expand(
        relation.targetId,
        nodeId,
        relation.id,
        depth + 1,
        nextPath,
        [...relationPath, relation.id],
      ));
    }
    return item;
  };
  const roots: KnowledgeTreeItem[] = [];
  for (const node of nodes) {
    if ((incoming.get(node.id)?.length ?? 0) > 0) continue;
    if (itemCount >= maxItems) { projectionTruncated = true; break; }
    roots.push(expand(node.id, null, undefined, 0, [], []));
  }
  // A cycle has no natural root. Surface every still-uncovered component once.
  for (const node of nodes) {
    if (covered.has(node.id)) continue;
    if (itemCount >= maxItems) { projectionTruncated = true; break; }
    roots.push(expand(node.id, null, undefined, 0, [], []));
  }
  return { roots, cycleRelationIds: [...cycleRelationIds], truncated: projectionTruncated };
}

/** Group cards by UTC creation time. Call queryKnowledgeNodes first and pass
 *  its nodeIds to make every view share exactly the same filter result. */
export function groupKnowledgeCardsByTime(
  graph: KnowledgeGraphInput,
  options: CardTimeOptions = {},
): CardTimeGroup[] {
  const nodes = selectedNodes(graph, options.nodeIds);
  const granularity = options.granularity ?? 'day';
  const direction = options.direction ?? 'newest';
  const inputOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const buckets = new Map<string, { node: ThoughtNode; time: number; iso?: string }[]>();
  for (const node of nodes) {
    const raw = node.data.createdAt;
    const time = raw ? Date.parse(raw) : Number.NaN;
    const iso = Number.isFinite(time) ? new Date(time).toISOString() : undefined;
    const key = !iso ? 'undated' : granularity === 'year' ? iso.slice(0, 4) : granularity === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
    const bucket = buckets.get(key);
    const entry = { node, time, iso };
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  const groups = [...buckets.entries()].map(([key, entries]) => {
    entries.sort((a, b) => {
      if (Number.isFinite(a.time) && Number.isFinite(b.time) && a.time !== b.time) {
        return direction === 'newest' ? b.time - a.time : a.time - b.time;
      }
      return inputOrder.get(a.node.id)! - inputOrder.get(b.node.id)!;
    });
    const dated = entries.filter((entry) => entry.iso);
    return {
      key,
      nodeIds: entries.map((entry) => entry.node.id),
      ...(dated.length > 0 ? {
        newestAt: dated.reduce((best, entry) => entry.time > best.time ? entry : best).iso,
        oldestAt: dated.reduce((best, entry) => entry.time < best.time ? entry : best).iso,
      } : {}),
    } satisfies CardTimeGroup;
  });
  groups.sort((a, b) => {
    if (a.key === 'undated') return 1;
    if (b.key === 'undated') return -1;
    return direction === 'newest' ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key);
  });
  return groups;
}
