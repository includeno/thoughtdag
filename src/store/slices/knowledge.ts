import type { StateCreator } from 'zustand';
import type { OrganizationRelation, ThoughtNode } from '../../types';
import type { KnowledgeSlice, StoreState } from '../types';
import { generateId } from '../../utils';
import { checkOrganizationRelation } from '../../lib/knowledge';

const COLORS = ['#6B5CE7', '#0F766E', '#B45309', '#0369A1', '#BE123C', '#6D28D9', '#3F6212'];

function normalizedName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function blankConceptNode(id: string, position: { x: number; y: number }): ThoughtNode {
  return {
    id,
    type: 'thought',
    position,
    dragHandle: '.drag-handle',
    data: {
      question: '',
      response: '',
      responses: [],
      responseIndex: -1,
      isCollapsed: false,
      isEditing: false,
      isEditingResponse: false,
      isLoading: false,
      createdAt: new Date().toISOString(),
      stepKind: 'note',
      tokenCount: 0,
      highlights: [],
      highlightMode: 'tag',
      attachments: [],
      excludedAttachmentIds: [],
      includedAttachmentIds: [],
      roleMode: 'inherit',
      isRoot: false,
      isBranch: false,
    },
  };
}

export const createKnowledgeSlice: StateCreator<StoreState, [], [], KnowledgeSlice> = (set, get) => ({
  organizationRelations: [],
  taxonomy: { tags: [], nodeTypes: [] },

  createOrganizationNode: (nodeId, direction) => {
    const anchor = get().nodes.find((node) => node.id === nodeId);
    if (!anchor || anchor.data.stepKind === 'frame') return null;
    const id = generateId();
    const vertical = direction === 'parent' ? -260 : 260;
    const node = blankConceptNode(id, { x: anchor.position.x, y: anchor.position.y + vertical });
    const relation: OrganizationRelation = {
      id: `org-${generateId()}`,
      sourceId: direction === 'parent' ? id : nodeId,
      targetId: direction === 'parent' ? nodeId : id,
      kind: 'parent',
      createdAt: new Date().toISOString(),
    };
    get().pushHistory();
    set((state) => ({
      nodes: [...state.nodes, node],
      organizationRelations: [...state.organizationRelations, relation],
      selectedNodeId: id,
      selectedNodeIds: [id],
    }));
    get().setSelectedNodeId(id);
    get().pushHistory(`organization.create-${direction}`);
    return id;
  },

  connectOrganization: (sourceId, targetId, kind) => {
    const state = get();
    const source = state.nodes.find((node) => node.id === sourceId);
    const target = state.nodes.find((node) => node.id === targetId);
    if (!source || !target || source.data.stepKind === 'frame' || target.data.stepKind === 'frame') return null;
    if (!checkOrganizationRelation(state.organizationRelations, { sourceId, targetId, kind }).ok) return null;
    const relation: OrganizationRelation = {
      id: `org-${generateId()}`,
      sourceId,
      targetId,
      kind,
      createdAt: new Date().toISOString(),
    };
    state.pushHistory();
    set((current) => ({ organizationRelations: [...current.organizationRelations, relation] }));
    get().pushHistory(`organization.connect-${kind}`);
    return relation.id;
  },

  deleteOrganizationRelations: (relationIds) => {
    const ids = new Set(relationIds);
    const state = get();
    if (ids.size === 0 || [...ids].some((id) => !state.organizationRelations.some((relation) => relation.id === id))) return false;
    state.pushHistory();
    set((state) => ({ organizationRelations: state.organizationRelations.filter((relation) => !ids.has(relation.id)) }));
    get().pushHistory('organization.delete');
    return true;
  },

  createTag: (rawName, color) => {
    const name = normalizedName(rawName);
    if (!name || get().taxonomy.tags.some((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return null;
    const id = generateId();
    get().pushHistory();
    set((state) => ({
      taxonomy: {
        ...state.taxonomy,
        tags: [...state.taxonomy.tags, { id, name, color: color ?? COLORS[state.taxonomy.tags.length % COLORS.length], createdAt: new Date().toISOString() }],
      },
    }));
    get().pushHistory('taxonomy.tag-create');
    return id;
  },

  renameTag: (tagId, rawName) => {
    const name = normalizedName(rawName);
    const state = get();
    if (!name || state.taxonomy.tags.some((tag) => tag.id !== tagId && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return;
    if (!state.taxonomy.tags.some((tag) => tag.id === tagId && tag.name !== name)) return;
    state.pushHistory();
    set((current) => ({ taxonomy: { ...current.taxonomy, tags: current.taxonomy.tags.map((tag) => tag.id === tagId ? { ...tag, name } : tag) } }));
    get().pushHistory('taxonomy.tag-rename');
  },

  deleteTag: (tagId) => {
    if (!get().taxonomy.tags.some((tag) => tag.id === tagId)) return;
    get().pushHistory();
    set((state) => ({
      taxonomy: { ...state.taxonomy, tags: state.taxonomy.tags.filter((tag) => tag.id !== tagId) },
      nodes: state.nodes.map((node) => node.data.tagIds?.includes(tagId)
        ? { ...node, data: { ...node.data, tagIds: node.data.tagIds.filter((id) => id !== tagId) } }
        : node),
    }));
    get().pushHistory('taxonomy.tag-delete');
  },

  createNodeType: (rawName, color) => {
    const name = normalizedName(rawName);
    if (!name || get().taxonomy.nodeTypes.some((type) => type.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return null;
    const id = generateId();
    get().pushHistory();
    set((state) => ({
      taxonomy: {
        ...state.taxonomy,
        nodeTypes: [...state.taxonomy.nodeTypes, { id, name, color: color ?? COLORS[state.taxonomy.nodeTypes.length % COLORS.length], createdAt: new Date().toISOString() }],
      },
    }));
    get().pushHistory('taxonomy.type-create');
    return id;
  },

  renameNodeType: (typeId, rawName) => {
    const name = normalizedName(rawName);
    const state = get();
    if (!name || state.taxonomy.nodeTypes.some((type) => type.id !== typeId && type.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return;
    if (!state.taxonomy.nodeTypes.some((type) => type.id === typeId && type.name !== name)) return;
    state.pushHistory();
    set((current) => ({ taxonomy: { ...current.taxonomy, nodeTypes: current.taxonomy.nodeTypes.map((type) => type.id === typeId ? { ...type, name } : type) } }));
    get().pushHistory('taxonomy.type-rename');
  },

  deleteNodeType: (typeId) => {
    if (!get().taxonomy.nodeTypes.some((type) => type.id === typeId)) return;
    get().pushHistory();
    set((state) => ({
      taxonomy: { ...state.taxonomy, nodeTypes: state.taxonomy.nodeTypes.filter((type) => type.id !== typeId) },
      nodes: state.nodes.map((node) => node.data.customTypeId === typeId
        ? { ...node, data: { ...node.data, customTypeId: undefined } }
        : node),
    }));
    get().pushHistory('taxonomy.type-delete');
  },

  setNodeTag: (nodeIds, tagId, assigned) => {
    const state = get();
    const ids = new Set(nodeIds);
    if (ids.size === 0
      || !state.taxonomy.tags.some((tag) => tag.id === tagId)
      || [...ids].some((id) => !state.nodes.some((node) => node.id === id))) return;
    const changed = state.nodes.some((node) => ids.has(node.id) && (node.data.tagIds?.includes(tagId) ?? false) !== assigned);
    if (!changed) return;
    state.pushHistory();
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (!ids.has(node.id)) return node;
        const tags = new Set(node.data.tagIds ?? []);
        if (assigned) tags.add(tagId); else tags.delete(tagId);
        return { ...node, data: { ...node.data, tagIds: [...tags] } };
      }),
    }));
    get().pushHistory(assigned ? 'taxonomy.tag-assign' : 'taxonomy.tag-remove');
  },

  setNodeCustomType: (nodeIds, typeId) => {
    const state = get();
    const ids = new Set(nodeIds);
    if (ids.size === 0
      || (typeId && !state.taxonomy.nodeTypes.some((type) => type.id === typeId))
      || [...ids].some((id) => !state.nodes.some((node) => node.id === id))) return;
    if (!state.nodes.some((node) => ids.has(node.id) && node.data.customTypeId !== typeId)) return;
    state.pushHistory();
    set((state) => ({ nodes: state.nodes.map((node) => ids.has(node.id) ? { ...node, data: { ...node.data, customTypeId: typeId } } : node) }));
    get().pushHistory('taxonomy.type-assign');
  },

  classifyNodes: (nodeIds, classification) => {
    const state = get();
    const ids = new Set(nodeIds);
    if (ids.size === 0 || [...ids].some((id) => !state.nodes.some((node) => node.id === id))) return;
    const hasTags = Object.prototype.hasOwnProperty.call(classification, 'tagIds');
    const hasType = Object.prototype.hasOwnProperty.call(classification, 'customTypeId');
    if (!hasTags && !hasType) return;

    const tagIds = hasTags ? [...new Set(classification.tagIds ?? [])] : undefined;
    if (tagIds?.some((id) => !state.taxonomy.tags.some((tag) => tag.id === id))) return;
    const customTypeId = classification.customTypeId ?? undefined;
    if (hasType && customTypeId && !state.taxonomy.nodeTypes.some((type) => type.id === customTypeId)) return;

    const changed = state.nodes.some((node) => {
      if (!ids.has(node.id)) return false;
      const currentTags = node.data.tagIds ?? [];
      const tagsChanged = hasTags && (currentTags.length !== tagIds!.length
        || currentTags.some((id, index) => id !== tagIds![index]));
      const typeChanged = hasType && node.data.customTypeId !== customTypeId;
      return tagsChanged || typeChanged;
    });
    if (!changed) return;

    state.pushHistory();
    set((current) => ({
      nodes: current.nodes.map((node) => {
        if (!ids.has(node.id)) return node;
        return {
          ...node,
          data: {
            ...node.data,
            ...(hasTags ? { tagIds } : {}),
            ...(hasType ? { customTypeId } : {}),
          },
        };
      }),
    }));
    get().pushHistory('taxonomy.node-classify');
  },
});
