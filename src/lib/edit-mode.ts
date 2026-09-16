import type { ThoughtData } from '../types';

export type EditMode = NonNullable<ThoughtData['editMode']>;

export function nodeEditMode(data: Pick<ThoughtData, 'stepKind' | 'editMode'>): EditMode | undefined {
  return data.stepKind === 'note' ? 'manual' : data.stepKind ? undefined : data.editMode ?? 'ai';
}

export function hasValidEditMode(data: { stepKind?: unknown; editMode?: unknown }): boolean {
  return data.editMode === undefined || (
    (data.editMode === 'manual' || data.editMode === 'manual-detail' || data.editMode === 'ai')
    && (!data.stepKind || (data.stepKind === 'note' && data.editMode === 'manual'))
  );
}

export function editModePatch(data: ThoughtData, mode: unknown): Partial<ThoughtData> {
  if (mode !== 'manual' && mode !== 'manual-detail' && mode !== 'ai') {
    throw new Error('editMode must be manual, manual-detail, or ai');
  }
  if (nodeEditMode(data) === undefined) throw new Error('This node kind does not support editMode');
  if (data.isLoading) throw new Error('Stop generation before switching editMode');
  return { editMode: mode, ...(data.stepKind === 'note' && mode !== 'manual' ? { stepKind: undefined } : {}) };
}
