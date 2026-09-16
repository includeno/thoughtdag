import { responseVersions, withResponseVersions } from '../../lib/response-versions';
import type { StateCreator } from 'zustand';
import type { Highlight } from '../../types';
import type { StoreState, HighlightSlice } from '../types';

export const createHighlightSlice: StateCreator<StoreState, [], [], HighlightSlice> = (set, get) => ({
  addHighlight: (nodeId: string, highlight: Highlight) => {
    get().pushHistory();
    get().logEvent('highlight-add', nodeId, { chars: highlight.text.length });
    // Normalize: collapse whitespace/newlines to single space
    const normalizedHighlight = { at: new Date().toISOString(), ...highlight, text: highlight.text.replace(/\s+/g, ' ').trim() };
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, highlights: [...n.data.highlights, normalizedHighlight] } }
          : n
      ),
    }));
    get().pushHistory();
  },

  removeHighlight: (nodeId: string, highlightId: string) => {
    get().pushHistory();
    get().logEvent('highlight-remove', nodeId);
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, highlights: n.data.highlights.filter((h) => h.id !== highlightId) } }
          : n
      ),
    }));
    get().pushHistory();
  },

  setHighlightMode: (nodeId: string, mode: 'off' | 'tag' | 'filter') => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, highlightMode: mode } } : n
      ),
    }));
  },

  // Material nodes (file / note / link) have no responses[] to index into —
  // their one summary lives at slot 0, unconditionally.
  setMaterialSummary: (nodeId: string, summary: string, topic?: string) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, summaries: [summary], summaryTypes: ['insight'], summaryTopics: [topic] } }
          : n,
      ),
    }));
  },

  setSummary: (nodeId, summary, forResponse, type, topic, versionId) => {
    set((state) => ({ nodes: state.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const versions = responseVersions(n.data);
      const idx = versionId ? versions.findIndex(v => v.id === versionId && v.response === forResponse)
        : versions.findIndex(v => v.response === forResponse);
      if (idx === -1) return n;
      const next = versions.map((v, i) => i === idx ? { ...v, summary, summaryType: type ?? 'insight', summaryTopic: topic } : v);
      const projected = withResponseVersions(n.data, next);
      // A late summary must never overwrite a draft or an in-flight response.
      return { ...n, data: { ...projected, question: n.data.question, response: n.data.response } };
    }) }));
  },
});
