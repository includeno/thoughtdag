import { set as idbSet } from 'idb-keyval';
import { flushPendingTransaction, useStore, stripTransient } from '../store';
import {
  adoptImportedProject,
  createProject,
  deleteProject,
  projectStorageKey,
  renameProject,
  switchProject,
  useProjects,
} from '../store/projects';
import type {
  Attachment,
  CanvasEvent,
  NodeTypeDefinition,
  OrganizationRelation,
  TagDefinition,
  ThoughtData,
  ThoughtEdge,
  ThoughtNode,
} from '../types';
import type { CanvasTransaction, ProjectTaxonomy } from '../store/types';
import type { ProjectMeta } from '../store/projects';
import { generateId, countTokens } from '../utils';
import { autoLayout } from './layout';
import { COLORS } from './constants';
import { buildContentNode, fetchLinkIntoNode, ingestFiles } from './content';
import {
  inlineVaultedContent,
  inlineVaultedTransactions,
  internNodes,
  internTransactions,
} from './attachment-vault';
import { walkUpAncestors } from './graph';
import { pruneHighlights } from './highlight-match';
import { checkOrganizationRelation, findParentCycles } from './knowledge';
import { parseCanvasEvents, parseTransactionLedger, validateTransactionHistory } from './transaction-import';

type CliArgs = Record<string, unknown>;
const CLI_NODE_KINDS = new Set(['ask', 'note', 'file', 'link', 'frame', 'human', 'prompt']);
const CLI_EDGE_RELATIONS = new Set(['structural', 'reference', 'watch']);
const CLI_TRANSFER_VERSION = 2;

export interface CliExecutionContext {
  setCancelHandler: (handler: () => void) => void;
  allowGenerativeProcessing?: boolean;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function edgeRelation(value: unknown, fallback = 'structural'): string {
  const relation = value === undefined ? fallback : String(value);
  if (!CLI_EDGE_RELATIONS.has(relation)) {
    throw new Error('relation must be structural, reference, or watch');
  }
  return relation;
}

function nodeById(nodeId: unknown): ThoughtNode {
  const id = text(nodeId, 'nodeId');
  const node = useStore.getState().nodes.find((item) => item.id === id);
  if (!node) throw new Error(`Node not found: ${id}`);
  return node;
}

function edgeById(edgeId: unknown): ThoughtEdge {
  const id = text(edgeId, 'edgeId');
  const edge = useStore.getState().edges.find((item) => item.id === id);
  if (!edge) throw new Error(`Edge not found: ${id}`);
  return edge;
}

function stringIdArray(value: unknown, name: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be ${allowEmpty ? 'an' : 'a non-empty'} array of IDs`);
  }
  return [...new Set(value.map((item, index) => text(item, `${name}[${index}]`)))];
}

function normalizedDefinitionName(value: unknown, name: string): string {
  return text(value, name).trim().replace(/\s+/g, ' ');
}

function optionalColor(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value, 'color');
}

function organizationKind(value: unknown): 'parent' | 'jump' {
  if (value !== 'parent' && value !== 'jump') throw new Error('kind must be parent or jump');
  return value;
}

function commitGraph(nodes: ThoughtNode[], edges: ThoughtEdge[]): void {
  const state = useStore.getState();
  state.pushHistory();
  useStore.setState({ nodes, edges });
  useStore.getState().pushHistory();
}

function baseData(question = '', response = ''): ThoughtData {
  const hasResponse = !!response;
  return {
    question,
    response,
    responses: hasResponse ? [response] : [],
    responseIndex: hasResponse ? 0 : -1,
    isCollapsed: false,
    isEditing: false,
    isEditingResponse: false,
    isLoading: false,
    tokenCount: countTokens(question + response),
    highlights: [],
    highlightMode: 'tag',
    attachments: [],
    excludedAttachmentIds: [],
    includedAttachmentIds: [],
    roleMode: 'inherit',
    isRoot: false,
    isBranch: false,
    createdAt: new Date().toISOString(),
  };
}

function makeEdge(source: ThoughtNode, target: ThoughtNode, relationValue: unknown, ignoreEdgeId?: string): ThoughtEdge {
  const relation = edgeRelation(relationValue);
  if (source.id === target.id) throw new Error('An edge cannot connect a node to itself');
  if (source.data.stepKind === 'frame') throw new Error('Frame nodes cannot be edge sources');
  if (['note', 'file', 'link', 'frame'].includes(target.data.stepKind ?? '')) {
    throw new Error('Material and frame nodes cannot receive incoming edges');
  }
  const existing = useStore.getState().edges.find((edge) => edge.id !== ignoreEdgeId && edge.source === source.id && edge.target === target.id);
  if (existing) throw new Error(`Edge already exists: ${existing.id}`);
  const now = new Date().toISOString();
  if (relation === 'watch') {
    return {
      id: `watch-${source.id}-${target.id}`,
      source: source.id,
      target: target.id,
      sourceHandle: 'branch',
      targetHandle: 'left',
      type: 'smoothstep',
      animated: true,
      style: { stroke: COLORS.watch, strokeWidth: 2, strokeDasharray: '4 4' },
      markerEnd: { type: 'arrowclosed', color: COLORS.watch, width: 18, height: 18 },
      data: { isCrossLink: true, isWatch: true, followsTip: true, createdAt: now },
    };
  }
  if (relation === 'reference') {
    return {
      id: `crosslink-${source.id}-${target.id}`,
      source: source.id,
      target: target.id,
      sourceHandle: 'branch',
      targetHandle: 'left',
      type: 'smoothstep',
      animated: true,
      style: { stroke: COLORS.accent, strokeWidth: 2, strokeDasharray: '8 4' },
      markerEnd: { type: 'arrowclosed', color: COLORS.accent, width: 18, height: 18 },
      data: { isCrossLink: true, createdAt: now },
    };
  }
  const structural = useStore.getState().edges.filter((edge) => !edge.data?.isCrossLink);
  const ancestors = walkUpAncestors(source.id, useStore.getState().nodes, structural).ordered;
  if (ancestors.some((node) => node.id === target.id)) throw new Error('Structural edge would create a cycle');
  return {
    id: `edge-${source.id}-${target.id}`,
    source: source.id,
    target: target.id,
    sourceHandle: 'continue',
    targetHandle: 'top',
    type: 'smoothstep',
    animated: false,
    style: { stroke: COLORS.accent, strokeWidth: 2 },
    markerEnd: { type: 'arrowclosed', color: COLORS.accent, width: 18, height: 18 },
    data: {},
  };
}

async function createNode(args: CliArgs): Promise<Record<string, unknown>> {
  const state = useStore.getState();
  const kind = optionalText(args.kind) || 'ask';
  if (!CLI_NODE_KINDS.has(kind)) throw new Error(`Unsupported node kind: ${kind}`);
  if (kind === 'link' && !optionalText(args.url)) throw new Error('url is required for link nodes');
  const position = {
    x: numberValue((args.position as { x?: unknown } | undefined)?.x, 120),
    y: numberValue((args.position as { y?: unknown } | undefined)?.y, 80),
  };
  const question = optionalText(args.question) ?? optionalText(args.text) ?? '';
  const response = optionalText(args.response) ?? '';
  let node: ThoughtNode;
  if (kind === 'note' || kind === 'file' || kind === 'link') {
    node = buildContentNode(kind, position, { question, linkUrl: optionalText(args.url) });
  } else if (kind === 'frame') {
    node = {
      id: generateId(), type: 'thought', position,
      width: numberValue(args.width, 640), height: numberValue(args.height, 420), zIndex: -1,
      dragHandle: '.drag-handle',
      data: { ...baseData(question), stepKind: 'frame', frameCarry: false },
    };
  } else {
    const stepKind = kind === 'human' || kind === 'prompt' ? kind : undefined;
    node = {
      id: generateId(), type: 'thought', position, dragHandle: '.drag-handle',
      data: {
        ...baseData(question, response),
        stepKind,
        instruction: optionalText(args.instruction),
        rolePrompt: optionalText(args.rolePrompt),
        isRoot: !optionalText(args.parentId),
      },
    };
  }
  const parentId = optionalText(args.parentId);
  let edges = state.edges;
  if (parentId) {
    const parent = nodeById(parentId);
    if (parent.data.stepKind === 'frame') throw new Error('Frame nodes cannot be edge sources');
    if (['note', 'file', 'link', 'frame'].includes(node.data.stepKind ?? '')) {
      throw new Error('Material and frame nodes cannot receive an incoming parent edge');
    }
    edges = [...edges, makeEdge(parent, node, args.relation)];
    node = { ...node, data: { ...node.data, isRoot: false } };
  }
  const nodes = parentId ? autoLayout([...state.nodes, node], edges) : [...state.nodes, node];
  commitGraph(nodes, edges);
  if (kind === 'note' || kind === 'file' || kind === 'link') {
    useStore.getState().logEvent('material-add', node.id, { cli: true, kind });
  }
  if (kind === 'link' && optionalText(args.url)) await fetchLinkIntoNode(node.id, String(args.url));
  return { id: node.id, node: useStore.getState().nodes.find((item) => item.id === node.id) };
}

function updateNode(args: CliArgs): Record<string, unknown> {
  const current = nodeById(args.nodeId);
  const inputPatch = args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)
    ? args.patch as CliArgs
    : args;
  const rawPatch: CliArgs = { ...inputPatch };
  if ('question' in rawPatch && typeof rawPatch.question !== 'string') throw new Error('patch.question must be a string');
  if ('response' in rawPatch && typeof rawPatch.response !== 'string') throw new Error('patch.response must be a string');
  for (const key of ['instruction', 'rolePrompt', 'model', 'frameColor', 'linkUrl', 'linkTitle'] as const) {
    if (!(key in rawPatch)) continue;
    if (rawPatch[key] === null) rawPatch[key] = undefined;
    else if (rawPatch[key] !== undefined && typeof rawPatch[key] !== 'string') throw new Error(`patch.${key} must be a string or null`);
  }
  for (const key of ['isCollapsed', 'archived', 'frameCarry', 'webSearch', 'scholarSearch', 'autoRerun'] as const) {
    if (key in rawPatch && typeof rawPatch[key] !== 'boolean') throw new Error(`patch.${key} must be a boolean`);
  }
  if ('roleMode' in rawPatch && !['inherit', 'set-next', 'reset'].includes(String(rawPatch.roleMode))) {
    throw new Error('patch.roleMode must be inherit, set-next, or reset');
  }
  if ('highlightMode' in rawPatch && !['off', 'tag', 'filter'].includes(String(rawPatch.highlightMode))) {
    throw new Error('patch.highlightMode must be off, tag, or filter');
  }
  if ('autoRerunRounds' in rawPatch
    && (typeof rawPatch.autoRerunRounds !== 'number' || !Number.isInteger(rawPatch.autoRerunRounds)
      || rawPatch.autoRerunRounds < 1 || rawPatch.autoRerunRounds > 5)) {
    throw new Error('patch.autoRerunRounds must be an integer from 1 to 5');
  }
  for (const key of ['width', 'height'] as const) {
    if (key in rawPatch && (typeof rawPatch[key] !== 'number' || !Number.isFinite(rawPatch[key]) || rawPatch[key] <= 0)) {
      throw new Error(`patch.${key} must be a positive finite number`);
    }
  }
  const allowed: (keyof ThoughtData)[] = [
    'question', 'instruction', 'isCollapsed', 'archived', 'rolePrompt', 'roleMode', 'model',
    'frameColor', 'frameCarry', 'webSearch', 'scholarSearch', 'autoRerun', 'autoRerunRounds',
    'highlightMode', 'linkUrl', 'linkTitle',
  ];
  const dataPatch: Partial<ThoughtData> = {};
  for (const key of allowed) {
    if (key in rawPatch) Object.assign(dataPatch, { [key]: rawPatch[key] });
  }
  if ('response' in rawPatch) {
    const response = String(rawPatch.response ?? '');
    const responses = [...current.data.responses];
    let responseIndex = current.data.responseIndex;
    if (responseIndex >= 0) responses[responseIndex] = response;
    else { responses.push(response); responseIndex = 0; }
    const editedAts = [...(current.data.editedAts ?? [])];
    editedAts[responseIndex] = new Date().toISOString();
    const summaries = [...(current.data.summaries ?? [])];
    const summaryTypes = [...(current.data.summaryTypes ?? [])];
    const summaryTopics = [...(current.data.summaryTopics ?? [])];
    summaries[responseIndex] = undefined;
    summaryTypes[responseIndex] = undefined;
    summaryTopics[responseIndex] = undefined;
    Object.assign(dataPatch, {
      response, responses, responseIndex, editedAts, summaries, summaryTypes, summaryTopics,
      highlights: pruneHighlights(current.data.highlights, response),
    });
  }
  if ('question' in dataPatch) {
    dataPatch.askedAt = new Date().toISOString();
    if (current.data.responses.length > 0 && dataPatch.question !== current.data.question) {
      const questions = current.data.responses.map((_, index) => current.data.questions?.[index] ?? current.data.question);
      if ('response' in rawPatch && (dataPatch.responseIndex ?? -1) >= 0) {
        questions[dataPatch.responseIndex!] = String(dataPatch.question);
      }
      dataPatch.questions = questions;
    }
  }
  if ('question' in dataPatch || 'response' in dataPatch) {
    dataPatch.tokenCount = countTokens(String(dataPatch.question ?? current.data.question) + String(dataPatch.response ?? current.data.response));
  }
  if (dataPatch.archived) dataPatch.archivedAt = new Date().toISOString();
  if (dataPatch.archived === false) { dataPatch.archived = undefined; dataPatch.archivedAt = undefined; }
  const nodes = useStore.getState().nodes.map((node) => node.id === current.id
    ? {
        ...node,
        ...(typeof rawPatch.width === 'number' ? { width: rawPatch.width } : {}),
        ...(typeof rawPatch.height === 'number' ? { height: rawPatch.height } : {}),
        data: { ...node.data, ...dataPatch },
      }
    : node);
  commitGraph(nodes, useStore.getState().edges);
  return { id: current.id, node: useStore.getState().nodes.find((node) => node.id === current.id) };
}

function compactNode(node: ThoughtNode) {
  return {
    id: node.id,
    kind: node.data.stepKind ?? 'ask',
    question: node.data.question,
    response: node.data.response,
    position: node.position,
    archived: !!node.data.archived,
    attachments: (node.data.attachments ?? []).map((attachment) => ({ id: attachment.id, name: attachment.name, type: attachment.type, size: attachment.size })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseSharedReadonly(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('sharedReadonly must be a boolean');
  return value;
}

function normalizeImportedNode(value: unknown, name: string): ThoughtNode {
  if (!isRecord(value) || !isNonEmptyString(value.id)) throw new Error(`${name} requires a non-empty id`);
  if (!isRecord(value.position)
    || typeof value.position.x !== 'number' || !Number.isFinite(value.position.x)
    || typeof value.position.y !== 'number' || !Number.isFinite(value.position.y)) {
    throw new Error(`${name} ${value.id} requires a finite position`);
  }
  if (!isRecord(value.data)) throw new Error(`${name} ${value.id} requires data`);
  if (value.data.tagIds !== undefined
    && (!Array.isArray(value.data.tagIds) || value.data.tagIds.some((id) => !isNonEmptyString(id)))) {
    throw new Error(`${name} ${value.id} has invalid tagIds`);
  }
  if (value.data.customTypeId !== undefined && !isNonEmptyString(value.data.customTypeId)) {
    throw new Error(`${name} ${value.id} has an invalid customTypeId`);
  }
  const tagIds = Array.isArray(value.data.tagIds) ? [...new Set(value.data.tagIds)] : [];
  return {
    ...(value as unknown as ThoughtNode),
    data: { ...(value.data as unknown as ThoughtData), tagIds },
  };
}

function validateImportedEdge(value: unknown, name: string): ThoughtEdge {
  if (!isRecord(value) || !isNonEmptyString(value.id)) throw new Error(`${name} requires a non-empty id`);
  if (!isNonEmptyString(value.source) || !isNonEmptyString(value.target)) {
    throw new Error(`${name} ${value.id} requires source and target IDs`);
  }
  if (value.source === value.target) throw new Error(`${name} ${value.id} cannot be a self-loop`);
  if (isRecord(value.data) && value.data.isOrganization === true) {
    throw new Error(`${name} ${value.id} is a render-only organization edge`);
  }
  return value as unknown as ThoughtEdge;
}

function assertStructuralAcyclic(edges: readonly ThoughtEdge[], nodeIds: ReadonlySet<string>): void {
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const edge of edges) {
    if (edge.data?.isCrossLink) continue;
    outgoing.get(edge.source)!.push(edge.target);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of nodeIds) {
    if (visit(id)) throw new Error('Imported structural edges contain a cycle');
  }
}

function validateImportedGraph(args: CliArgs, strictEndpoints = true): { nodes: ThoughtNode[]; edges: ThoughtEdge[] } {
  if (args.format === 'thoughtdag-manifest') throw new Error('A run manifest is not an importable canvas backup');
  if (!Array.isArray(args.nodes) || !Array.isArray(args.edges)) throw new Error('nodes and edges arrays required');
  const ids = new Set<string>();
  const nodes = args.nodes.map((candidate, index) => {
    const node = normalizeImportedNode(candidate, `nodes[${index}]`);
    if (ids.has(node.id)) throw new Error(`Duplicate imported node id: ${node.id}`);
    ids.add(node.id);
    return node;
  });
  const edgeIds = new Set<string>();
  const edges = args.edges.map((candidate, index) => {
    const edge = validateImportedEdge(candidate, `edges[${index}]`);
    if (edgeIds.has(edge.id)) throw new Error(`Duplicate imported edge id: ${edge.id}`);
    if (strictEndpoints && (!ids.has(edge.source) || !ids.has(edge.target))) {
      throw new Error(`Imported edge ${edge.id} references a missing node`);
    }
    edgeIds.add(edge.id);
    return edge;
  });
  if (strictEndpoints) assertStructuralAcyclic(edges, ids);
  return { nodes, edges };
}

function validateDefinitions<T extends TagDefinition | NodeTypeDefinition>(
  value: unknown,
  name: string,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)
      || !isNonEmptyString(candidate.id)
      || !isNonEmptyString(candidate.name)
      || !isNonEmptyString(candidate.color)
      || !isNonEmptyString(candidate.createdAt)) {
      throw new Error(`${name}[${index}] is invalid`);
    }
    const normalizedName = candidate.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    if (ids.has(candidate.id)) throw new Error(`Duplicate ${name} id: ${candidate.id}`);
    if (names.has(normalizedName)) throw new Error(`Duplicate ${name} name: ${candidate.name}`);
    ids.add(candidate.id);
    names.add(normalizedName);
    return candidate as unknown as T;
  });
}

function parseTaxonomy(value: unknown): ProjectTaxonomy {
  if (value === undefined) return { tags: [], nodeTypes: [] };
  if (!isRecord(value)) throw new Error('taxonomy must be an object');
  return {
    tags: validateDefinitions<TagDefinition>(value.tags, 'taxonomy.tags'),
    nodeTypes: validateDefinitions<NodeTypeDefinition>(value.nodeTypes, 'taxonomy.nodeTypes'),
  };
}

function validateOrganizationRelation(value: unknown, name: string): OrganizationRelation {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.sourceId)
    || !isNonEmptyString(value.targetId)
    || (value.kind !== 'parent' && value.kind !== 'jump')
    || !isNonEmptyString(value.createdAt)) {
    throw new Error(`${name} is invalid`);
  }
  if (value.sourceId === value.targetId) throw new Error(`${name} cannot be a self-loop`);
  return value as unknown as OrganizationRelation;
}

function parseOrganizationRelations(
  value: unknown,
  nodesById: ReadonlyMap<string, ThoughtNode>,
): OrganizationRelation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('organizationRelations must be an array');
  const ids = new Set<string>();
  const pairs = new Set<string>();
  const relations = value.map((candidate, index) => {
    const relation = validateOrganizationRelation(candidate, `organizationRelations[${index}]`);
    const source = nodesById.get(relation.sourceId);
    const target = nodesById.get(relation.targetId);
    if (!source || !target) throw new Error(`Organization relation ${relation.id} references a missing node`);
    if (source.data.stepKind === 'frame' || target.data.stepKind === 'frame') {
      throw new Error(`Organization relation ${relation.id} references a frame`);
    }
    if (ids.has(relation.id)) throw new Error(`Duplicate organization relation id: ${relation.id}`);
    const pair = `${relation.kind}\u0000${relation.sourceId}\u0000${relation.targetId}`;
    if (pairs.has(pair)) throw new Error(`Duplicate organization relation: ${relation.id}`);
    ids.add(relation.id);
    pairs.add(pair);
    return relation;
  });
  const cycles = findParentCycles(relations);
  if (cycles.length > 0) throw new Error(`Organization parent cycle: ${cycles[0].join(' -> ')}`);
  return relations;
}

function parseInstantiatedFrom(value: unknown): ProjectMeta['instantiatedFrom'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isNonEmptyString(value.name) || !isNonEmptyString(value.at)) {
    throw new Error('instantiatedFrom is invalid');
  }
  return { name: value.name, at: value.at };
}

type ParsedCliProjectImport = {
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
  organizationRelations: OrganizationRelation[];
  taxonomy: ProjectTaxonomy;
  sharedReadonly: boolean;
  name: string;
  instantiatedFrom?: ProjectMeta['instantiatedFrom'];
  events?: CanvasEvent[];
  transactions?: CanvasTransaction[];
  undoableTransactionIds?: string[];
  redoableTransactionIds?: string[];
  revision?: number;
};

export function parseCliProjectImport(args: CliArgs): ParsedCliProjectImport {
  const schemaVersion = args.schemaVersion ?? args.version ?? 1;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)
    || schemaVersion < 1 || schemaVersion > CLI_TRANSFER_VERSION) {
    throw new Error(`Unsupported project schema version: ${String(schemaVersion)}`);
  }
  const isV2 = schemaVersion === 2;
  const sharedReadonly = parseSharedReadonly(args.sharedReadonly);
  const graph = validateImportedGraph(args, isV2);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const organizationRelations = isV2 ? parseOrganizationRelations(args.organizationRelations, nodesById) : [];
  const taxonomy = isV2 ? parseTaxonomy(args.taxonomy) : { tags: [], nodeTypes: [] };
  const tagIds = new Set(taxonomy.tags.map((tag) => tag.id));
  const typeIds = new Set(taxonomy.nodeTypes.map((type) => type.id));
  for (const node of graph.nodes) {
    const unknownTagId = (node.data.tagIds ?? []).find((id) => !tagIds.has(id));
    if (unknownTagId) throw new Error(`Node ${node.id} references an unknown tag: ${unknownTagId}`);
    if (node.data.customTypeId && !typeIds.has(node.data.customTypeId)) {
      throw new Error(`Node ${node.id} references an unknown type: ${node.data.customTypeId}`);
    }
  }
  const name = optionalText(args.name)?.trim() || 'Imported canvas';
  const instantiatedFrom = parseInstantiatedFrom(args.instantiatedFrom);
  const base = {
    ...graph,
    organizationRelations,
    taxonomy,
    sharedReadonly,
    name,
    ...(instantiatedFrom ? { instantiatedFrom } : {}),
  };
  if (sharedReadonly) return base;
  if (!isV2) {
    return {
      ...base,
      events: Array.isArray(args.events) ? args.events as CanvasEvent[] : [],
      transactions: [],
      undoableTransactionIds: [],
      redoableTransactionIds: [],
      revision: 0,
    };
  }

  const ledger = parseTransactionLedger(args, {
    node: normalizeImportedNode,
    edge: validateImportedEdge,
    organizationRelation: validateOrganizationRelation,
    taxonomy: (value, name) => {
      if (value === undefined) throw new Error(`${name} is invalid`);
      return parseTaxonomy(value);
    },
  });
  validateTransactionHistory(ledger.transactions, {
    nodes: graph.nodes,
    edges: graph.edges,
    organizationRelations,
    taxonomy,
  });
  return {
    ...base,
    events: parseCanvasEvents(args.events),
    ...ledger,
  };
}

async function buildCliCanvasTransfer(sharedReadonlyValue: unknown): Promise<Record<string, unknown>> {
  const sharedReadonly = parseSharedReadonly(sharedReadonlyValue);
  if (!flushPendingTransaction('cli.canvas-transfer')) {
    throw new Error('Canvas transfer is unavailable while generation or extraction is in progress');
  }
  const snapshot = useStore.getState();
  const projects = useProjects.getState();
  const active = projects.projects.find((project) => project.id === projects.activeId);
  const nodes = stripTransient(await inlineVaultedContent(snapshot.nodes));
  return {
    schemaVersion: CLI_TRANSFER_VERSION,
    version: CLI_TRANSFER_VERSION,
    name: active?.name ?? 'canvas',
    exportedAt: new Date().toISOString(),
    ...(active?.instantiatedFrom ? { instantiatedFrom: active.instantiatedFrom } : {}),
    ...(sharedReadonly ? { sharedReadonly: true } : {}),
    nodes,
    edges: snapshot.edges,
    organizationRelations: snapshot.organizationRelations,
    taxonomy: snapshot.taxonomy,
    ...(sharedReadonly ? {} : {
      events: snapshot.events,
      transactions: await inlineVaultedTransactions(snapshot.transactions),
      undoableTransactionIds: snapshot.undoableTransactionIds,
      redoableTransactionIds: snapshot.redoableTransactionIds,
      revision: snapshot.revision,
    }),
  };
}

export async function executeCliCommand(
  command: string,
  args: CliArgs,
  execution?: CliExecutionContext,
): Promise<unknown> {
  const state = () => useStore.getState();
  switch (command) {
    case 'project.list':
      return { activeId: useProjects.getState().activeId, projects: useProjects.getState().projects };
    case 'canvas.get':
      return buildCliCanvasTransfer(args.sharedReadonly);
    case 'node.list':
      return state().nodes.map(compactNode);
    case 'node.get':
      return nodeById(args.nodeId);
    case 'edge.list':
      return state().edges;
    case 'project.create': {
      const id = await createProject(optionalText(args.name) || 'Untitled', args.kind === 'paradigm' ? 'paradigm' : 'chat');
      return { id, activeId: useProjects.getState().activeId };
    }
    case 'project.switch': {
      const projectId = text(args.projectId, 'projectId');
      if (!useProjects.getState().projects.some((project) => project.id === projectId)) {
        throw new Error(`Project not found: ${projectId}`);
      }
      await switchProject(projectId);
      return { activeId: useProjects.getState().activeId };
    }
    case 'project.rename': {
      const projectId = text(args.projectId, 'projectId');
      if (!useProjects.getState().projects.some((project) => project.id === projectId)) {
        throw new Error(`Project not found: ${projectId}`);
      }
      await renameProject(projectId, text(args.name, 'name'));
      return { ok: true };
    }
    case 'node.create':
      return createNode(args);
    case 'node.update':
      return updateNode(args);
    case 'node.move': {
      const node = nodeById(args.nodeId);
      const position = args.position as { x?: unknown; y?: unknown } | undefined;
      const nextPosition = { x: numberValue(position?.x, node.position.x), y: numberValue(position?.y, node.position.y) };
      const carried = new Map<string, { x: number; y: number }>();
      if (node.data.stepKind === 'frame' && node.data.frameCarry !== false) {
        const width = node.measured?.width ?? node.width ?? 0;
        const height = node.measured?.height ?? node.height ?? 0;
        const dx = nextPosition.x - node.position.x;
        const dy = nextPosition.y - node.position.y;
        for (const item of state().nodes) {
          if (item.id === node.id || item.data.stepKind === 'frame') continue;
          const centerX = item.position.x + (item.measured?.width ?? item.width ?? 520) / 2;
          const centerY = item.position.y + (item.measured?.height ?? item.height ?? 120) / 2;
          if (centerX >= node.position.x && centerX <= node.position.x + width
            && centerY >= node.position.y && centerY <= node.position.y + height) {
            carried.set(item.id, { x: item.position.x + dx, y: item.position.y + dy });
          }
        }
      }
      const nodes = state().nodes.map((item) => {
        if (item.id === node.id) return { ...item, position: nextPosition };
        const carriedPosition = carried.get(item.id);
        return carriedPosition ? { ...item, position: carriedPosition } : item;
      });
      commitGraph(nodes, state().edges);
      return { id: node.id, position: nodes.find((item) => item.id === node.id)?.position };
    }
    case 'node.duplicate': {
      const node = nodeById(args.nodeId);
      const before = new Set(state().nodes.map((item) => item.id));
      state().duplicateNode(node.id);
      return { id: state().nodes.find((item) => !before.has(item.id))?.id };
    }
    case 'node.archive': {
      const ids = Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : [text(args.nodeId, 'nodeId')];
      state().setArchived(ids, args.archived !== false);
      return { ids, archived: args.archived !== false };
    }
    case 'node.classify': {
      const nodeIds = stringIdArray(args.nodeIds, 'nodeIds');
      for (const nodeId of nodeIds) nodeById(nodeId);
      const hasTagIds = Object.prototype.hasOwnProperty.call(args, 'tagIds');
      const hasCustomTypeId = Object.prototype.hasOwnProperty.call(args, 'customTypeId');
      if (!hasTagIds && !hasCustomTypeId) {
        throw new Error('node.classify requires tagIds and/or customTypeId');
      }

      const classification: { tagIds?: string[]; customTypeId?: string | null } = {};
      if (hasTagIds) {
        const tagIds = stringIdArray(args.tagIds, 'tagIds', true);
        for (const tagId of tagIds) {
          if (!state().taxonomy.tags.some((tag) => tag.id === tagId)) throw new Error(`Tag not found: ${tagId}`);
        }
        classification.tagIds = tagIds;
      }
      if (hasCustomTypeId) {
        if (args.customTypeId === null) classification.customTypeId = null;
        else {
          const typeId = text(args.customTypeId, 'customTypeId');
          if (!state().taxonomy.nodeTypes.some((type) => type.id === typeId)) throw new Error(`Type not found: ${typeId}`);
          classification.customTypeId = typeId;
        }
      }

      state().classifyNodes(nodeIds, classification);
      const nodesById = new Map(state().nodes.map((node) => [node.id, node]));
      return {
        nodes: nodeIds.map((id) => {
          const node = nodesById.get(id)!;
          return { id, tagIds: [...(node.data.tagIds ?? [])], customTypeId: node.data.customTypeId ?? null };
        }),
      };
    }
    case 'edge.connect': {
      const source = nodeById(args.sourceId);
      const target = nodeById(args.targetId);
      const edge = makeEdge(source, target, args.relation);
      const edges = [...state().edges, edge];
      const nodes = edge.data?.isCrossLink ? state().nodes : autoLayout(state().nodes, edges);
      commitGraph(nodes, edges);
      state().logEvent('connect', edge.id, { cli: true });
      return edge;
    }
    case 'organization.connect': {
      const source = nodeById(args.sourceId);
      const target = nodeById(args.targetId);
      if (source.data.stepKind === 'frame' || target.data.stepKind === 'frame') {
        throw new Error('Frame nodes cannot be organization relation endpoints');
      }
      const kind = organizationKind(args.kind);
      const candidate = { sourceId: source.id, targetId: target.id, kind };
      const checked = checkOrganizationRelation(state().organizationRelations, candidate);
      if (!checked.ok) {
        const cycle = checked.cyclePath?.length ? `: ${checked.cyclePath.join(' -> ')}` : '';
        throw new Error(`Organization relation rejected (${checked.reason ?? 'invalid'})${cycle}`);
      }
      const id = state().connectOrganization(source.id, target.id, kind);
      if (!id) throw new Error('Organization relation could not be created');
      return state().organizationRelations.find((relation) => relation.id === id);
    }
    case 'edge.update': {
      const edge = edgeById(args.edgeId);
      const currentRelation = edge.data?.isWatch ? 'watch' : edge.data?.isCrossLink ? 'reference' : 'structural';
      const requestedRelation = args.relation !== undefined
        ? edgeRelation(args.relation)
        : typeof args.structural === 'boolean'
          ? (args.structural ? 'structural' : currentRelation === 'watch' ? 'watch' : 'reference')
          : currentRelation;
      const source = args.sourceId === undefined ? nodeById(edge.source) : nodeById(args.sourceId);
      const target = args.targetId === undefined ? nodeById(edge.target) : nodeById(args.targetId);
      const changesRelationOrEndpoints = requestedRelation !== currentRelation
        || source.id !== edge.source || target.id !== edge.target;
      let updated = changesRelationOrEndpoints
        ? { ...makeEdge(source, target, requestedRelation, edge.id), id: edge.id }
        : edge;
      if (args.depth !== undefined) {
        if (args.depth !== 'quote' && args.depth !== 'full') throw new Error('depth must be quote or full');
        if (!updated.data?.isCrossLink) throw new Error('depth applies only to reference or watch edges');
        updated = {
          ...updated,
          style: { ...updated.style, strokeDasharray: args.depth === 'full' ? '12 3' : '8 4', strokeWidth: args.depth === 'full' ? 3 : 2 },
          data: { ...updated.data, contextDepth: args.depth === 'full' ? 'full' : undefined },
        };
      }
      if (args.followsTip !== undefined) {
        if (typeof args.followsTip !== 'boolean') throw new Error('followsTip must be a boolean');
        updated = { ...updated, data: { ...updated.data, followsTip: args.followsTip } };
      }
      if (!changesRelationOrEndpoints && args.depth === undefined && args.followsTip === undefined && args.structural === undefined) {
        throw new Error('edge.update requires relation, structural, sourceId, targetId, depth, or followsTip');
      }
      const edges = state().edges.map((item) => item.id === edge.id ? updated : item);
      const needsLayout = !updated.data?.isCrossLink || !edge.data?.isCrossLink;
      commitGraph(needsLayout ? autoLayout(state().nodes, edges) : state().nodes, edges);
      return updated;
    }
    case 'attachment.add': {
      const node = nodeById(args.nodeId);
      const input = args.attachment as Record<string, unknown> | undefined;
      if (!input) throw new Error('attachment required');
      const name = text(input.name, 'attachment.name');
      const type = optionalText(input.type) || 'application/octet-stream';
      const content = optionalText(input.content) ?? '';
      const bytes = input.encoding === 'base64'
        ? Uint8Array.from(atob(content), (char) => char.charCodeAt(0))
        : content;
      await ingestFiles(node.id, [new File([bytes], name, { type })], {
        allowGenerativeProcessing: execution?.allowGenerativeProcessing !== false,
      });
      const attachment = state().nodes.find((item) => item.id === node.id)?.data.attachments.at(-1);
      return attachment ? { id: attachment.id, name: attachment.name, type: attachment.type, size: attachment.size } : { ok: false };
    }
    case 'attachment.update': {
      const node = nodeById(args.nodeId);
      const attachmentId = text(args.attachmentId, 'attachmentId');
      const patch = args.patch && typeof args.patch === 'object' ? args.patch as Partial<Attachment> : {};
      const allowed: Partial<Attachment> = {};
      for (const key of ['name', 'extractedText', 'digest', 'renderMode'] as const) {
        if (key in patch) Object.assign(allowed, { [key]: patch[key] });
      }
      state().setAttachmentData(node.id, attachmentId, allowed);
      return { id: attachmentId };
    }
    case 'highlight.add': {
      const node = nodeById(args.nodeId);
      const id = generateId();
      state().addHighlight(node.id, { id, text: text(args.text, 'text') });
      return { id };
    }
    case 'highlight.mode': {
      const node = nodeById(args.nodeId);
      if (!['off', 'tag', 'filter'].includes(String(args.mode))) throw new Error('mode must be off, tag, or filter');
      state().setHighlightMode(node.id, args.mode as 'off' | 'tag' | 'filter');
      return { id: node.id, mode: args.mode };
    }
    case 'question.ask': {
      const parentId = optionalText(args.parentId);
      if (parentId) nodeById(parentId);
      const before = new Set(state().nodes.map((node) => node.id));
      const generation = state().addQuestion(text(args.question, 'question'), {
        parentId,
        branchContext: optionalText(args.branchContext),
        inheritRole: args.inheritRole !== false,
        rolePrompt: optionalText(args.rolePrompt),
        mentions: Array.isArray(args.mentions) ? args.mentions.map(String) : undefined,
      });
      // addQuestion creates the node synchronously before its first generation
      // await, so the control plane can expose a real stop hook immediately.
      await Promise.resolve();
      const created = state().nodes.find((node) => !before.has(node.id));
      if (created) execution?.setCancelHandler(() => state().stopGeneration(created.id));
      await generation;
      if (!created) throw new Error('Question was not created');
      const finished = nodeById(created.id);
      if (finished.data.generationFailed) throw new Error(finished.data.response || 'Generation failed');
      return compactNode(finished);
    }
    case 'node.regenerate': {
      const node = nodeById(args.nodeId);
      execution?.setCancelHandler(() => state().stopGeneration(node.id));
      await state().rerunNode(node.id);
      const finished = nodeById(node.id);
      if (finished.data.generationFailed) throw new Error(finished.data.response || 'Generation failed');
      return compactNode(finished);
    }
    case 'generation.stop': {
      const node = nodeById(args.nodeId);
      state().stopGeneration(node.id);
      return { id: node.id, stopped: true };
    }
    case 'canvas.relayout':
      state().relayout();
      return { nodes: state().nodes.map((node) => ({ id: node.id, position: node.position })) };
    case 'node.align': {
      const ids = Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : [];
      state().alignSelection(ids);
      return { ids };
    }
    case 'tag.create': {
      const name = normalizedDefinitionName(args.name, 'name');
      const id = state().createTag(name, optionalColor(args.color));
      if (!id) throw new Error(`Tag name already exists: ${name}`);
      return state().taxonomy.tags.find((tag) => tag.id === id);
    }
    case 'tag.rename': {
      const tagId = text(args.tagId, 'tagId');
      const current = state().taxonomy.tags.find((tag) => tag.id === tagId);
      if (!current) throw new Error(`Tag not found: ${tagId}`);
      const name = normalizedDefinitionName(args.name, 'name');
      if (state().taxonomy.tags.some((tag) => tag.id !== tagId && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error(`Tag name already exists: ${name}`);
      }
      state().renameTag(tagId, name);
      return state().taxonomy.tags.find((tag) => tag.id === tagId);
    }
    case 'type.create': {
      const name = normalizedDefinitionName(args.name, 'name');
      const id = state().createNodeType(name, optionalColor(args.color));
      if (!id) throw new Error(`Type name already exists: ${name}`);
      return state().taxonomy.nodeTypes.find((type) => type.id === id);
    }
    case 'type.rename': {
      const typeId = text(args.typeId, 'typeId');
      const current = state().taxonomy.nodeTypes.find((type) => type.id === typeId);
      if (!current) throw new Error(`Type not found: ${typeId}`);
      const name = normalizedDefinitionName(args.name, 'name');
      if (state().taxonomy.nodeTypes.some((type) => type.id !== typeId && type.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error(`Type name already exists: ${name}`);
      }
      state().renameNodeType(typeId, name);
      return state().taxonomy.nodeTypes.find((type) => type.id === typeId);
    }
    case 'history.undo':
      state().undo();
      return { historyIndex: state().historyIndex };
    case 'history.redo':
      state().redo();
      return { historyIndex: state().historyIndex };
    case 'canvas.export':
      return buildCliCanvasTransfer(args.sharedReadonly);
    case 'project.import': {
      const imported = parseCliProjectImport(args);
      const id = generateId();
      const nodes = await internNodes(imported.nodes);
      const transactions = imported.transactions
        ? await internTransactions(imported.transactions)
        : undefined;
      await idbSet(projectStorageKey(id), JSON.stringify({
        state: {
          nodes: stripTransient(nodes),
          edges: imported.edges,
          organizationRelations: imported.organizationRelations,
          taxonomy: imported.taxonomy,
          ...(imported.sharedReadonly ? {} : {
            events: imported.events,
            transactions,
            undoableTransactionIds: imported.undoableTransactionIds,
            redoableTransactionIds: imported.redoableTransactionIds,
            revision: imported.revision,
          }),
        },
        version: CLI_TRANSFER_VERSION,
      }));
      await adoptImportedProject(id, imported.name, 'chat', { instantiatedFrom: imported.instantiatedFrom });
      return {
        id,
        nodes: nodes.length,
        edges: imported.edges.length,
        organizationRelations: imported.organizationRelations.length,
        tags: imported.taxonomy.tags.length,
        nodeTypes: imported.taxonomy.nodeTypes.length,
        transactions: transactions?.length ?? 0,
        revision: imported.revision ?? 0,
        sharedReadonly: imported.sharedReadonly,
      };
    }
    case 'project.delete': {
      const projectId = text(args.projectId, 'projectId');
      if (!useProjects.getState().projects.some((project) => project.id === projectId)) {
        throw new Error(`Project not found: ${projectId}`);
      }
      await deleteProject(projectId);
      return { ok: true, activeId: useProjects.getState().activeId };
    }
    case 'node.delete': {
      const ids = Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : [text(args.nodeId, 'nodeId')];
      state().batchDelete(ids);
      return { ids };
    }
    case 'edge.delete': {
      const ids = Array.isArray(args.edgeIds) ? args.edgeIds.map(String) : [text(args.edgeId, 'edgeId')];
      state().deleteEdges(ids);
      return { ids };
    }
    case 'organization.delete': {
      const ids = args.relationIds === undefined
        ? [text(args.relationId, 'relationId')]
        : stringIdArray(args.relationIds, 'relationIds');
      if (!state().deleteOrganizationRelations(ids)) throw new Error('One or more organization relations were not found');
      return { ids };
    }
    case 'attachment.delete': {
      const node = nodeById(args.nodeId);
      const attachmentId = text(args.attachmentId, 'attachmentId');
      state().removeAttachment(node.id, attachmentId);
      return { id: attachmentId };
    }
    case 'highlight.delete': {
      const node = nodeById(args.nodeId);
      const highlightId = text(args.highlightId, 'highlightId');
      state().removeHighlight(node.id, highlightId);
      return { id: highlightId };
    }
    case 'version.delete': {
      const node = nodeById(args.nodeId);
      const versionIndex = numberValue(args.versionIndex, -1);
      if (!Number.isInteger(versionIndex) || versionIndex < 0) throw new Error('versionIndex must be a non-negative integer');
      state().deleteVersion(node.id, versionIndex);
      return { nodeId: node.id, versionIndex };
    }
    case 'tag.delete': {
      const tagId = text(args.tagId, 'tagId');
      if (!state().taxonomy.tags.some((tag) => tag.id === tagId)) throw new Error(`Tag not found: ${tagId}`);
      const affectedNodeIds = state().nodes.filter((node) => node.data.tagIds?.includes(tagId)).map((node) => node.id);
      state().deleteTag(tagId);
      return { id: tagId, affectedNodeIds };
    }
    case 'type.delete': {
      const typeId = text(args.typeId, 'typeId');
      if (!state().taxonomy.nodeTypes.some((type) => type.id === typeId)) throw new Error(`Type not found: ${typeId}`);
      const affectedNodeIds = state().nodes.filter((node) => node.data.customTypeId === typeId).map((node) => node.id);
      state().deleteNodeType(typeId);
      return { id: typeId, affectedNodeIds };
    }
    default:
      throw new Error(`Unsupported CLI command: ${command}`);
  }
}
