import type { ResponseVersion, ThoughtData } from '../types';

/** Legacy arrays are read once; provenance absent from old files stays unknown. */
export function responseVersions(data: ThoughtData): ResponseVersion[] {
  if (data.responseVersions) return data.responseVersions;
  return (data.responses ?? []).map((response, index) => ({
    id: `legacy-${index}`, question: data.questions?.[index] ?? data.question, response,
    author: data.generatedBy?.[index] ? 'model' : 'unknown',
    model: data.generatedBy?.[index] ?? undefined,
    reasoning: data.reasonings?.[index] ?? undefined, generatedAt: data.generatedAts?.[index], editedAt: data.editedAts?.[index],
    summary: data.summaries?.[index] ?? (index === data.responseIndex ? data.summary : undefined),
    summaryType: data.summaryTypes?.[index] ?? undefined, summaryTopic: data.summaryTopics?.[index] ?? undefined,
    gatewaySearch: data.gatewaySearches?.[index],
    ...(index === data.responseIndex ? { references: data.references, contextHash: data.lastContextHash } : {}),
  }));
}

/** One write path. Parallel arrays are compatibility projections for existing renderers. */
export function withResponseVersions(data: ThoughtData, versions: ResponseVersion[], index = data.responseIndex): ThoughtData {
  const selected = versions.length ? Math.max(0, Math.min(index, versions.length - 1)) : -1;
  const active = versions[selected];
  return {
    ...data, responseVersions: versions, responseIndex: selected,
    responses: versions.map(v => v.response), questions: versions.map(v => v.question),
    generatedBy: versions.map(v => v.model), reasonings: versions.map(v => v.reasoning),
    generatedAts: versions.map(v => v.generatedAt), editedAts: versions.map(v => v.editedAt),
    summaries: versions.map(v => v.summary), summaryTypes: versions.map(v => v.summaryType),
    summaryTopics: versions.map(v => v.summaryTopic), gatewaySearches: versions.map(v => v.gatewaySearch),
    question: active?.question ?? data.question, response: active?.response ?? '',
    references: active?.references, lastContextHash: active?.contextHash, lastGeneratedAt: active?.generatedAt,
    summary: undefined,
  };
}

export function editResponseVersion(data: ThoughtData, response: string, question = data.question): ThoughtData {
  const versions = [...responseVersions(data)];
  const index = data.responseIndex >= 0 && data.responseIndex < versions.length ? data.responseIndex : versions.length;
  versions[index] = {
    ...versions[index], id: versions[index]?.id ?? crypto.randomUUID(), question, response,
    author: 'user', editedAt: new Date().toISOString(), summary: undefined, summaryType: undefined, summaryTopic: undefined,
  };
  return withResponseVersions(data, versions, index);
}

/** Reject malformed records at Web, CLI and viewer boundaries. */
export function hasValidResponseVersions(data: { responseVersions?: unknown }): boolean {
  if (data.responseVersions === undefined) return true;
  if (!Array.isArray(data.responseVersions)) return false;
  const ids = new Set<string>();
  return data.responseVersions.every((v: unknown) => {
    if (!v || typeof v !== 'object') return false;
    const record = v as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id || ids.has(record.id)
      || typeof record.question !== 'string' || typeof record.response !== 'string'
      || !['user', 'model', 'unknown'].includes(String(record.author))) return false;
    ids.add(record.id);
    for (const key of ['model', 'reasoning', 'generatedAt', 'editedAt', 'summary', 'summaryType', 'summaryTopic', 'contextHash']) {
      if (record[key] !== undefined && typeof record[key] !== 'string') return false;
    }
    if (record.gatewaySearch !== undefined && typeof record.gatewaySearch !== 'boolean') return false;
    return record.references === undefined || (Array.isArray(record.references) && record.references.every((r: unknown) => {
      if (!r || typeof r !== 'object') return false;
      const ref = r as Record<string, unknown>;
      return typeof ref.title === 'string' && ['url', 'media', 'date'].every(key => ref[key] === undefined || typeof ref[key] === 'string');
    }));
  });
}
