import { Tags } from 'lucide-react';
import { useStore } from '../../store';

export default function NodeTaxonomyBadges({ tagIds = [], customTypeId, compact = false }: {
  tagIds?: string[];
  customTypeId?: string;
  compact?: boolean;
}) {
  const taxonomy = useStore((state) => state.taxonomy);
  const type = customTypeId ? taxonomy.nodeTypes.find((entry) => entry.id === customTypeId) : undefined;
  const tags = tagIds.map((id) => taxonomy.tags.find((entry) => entry.id === id)).filter((entry) => !!entry);
  if (!type && tags.length === 0) return null;
  const shown = tags.slice(0, compact ? 1 : 3);
  return (
    <span className="inline-flex items-center gap-1 min-w-0" data-node-taxonomy>
      {type && (
        <span className="text-2xs px-1.5 py-0.5 rounded-md border truncate max-w-[110px]" style={{ borderColor: `${type.color}66`, backgroundColor: `${type.color}16`, color: type.color }} title={type.name}>
          {type.name}
        </span>
      )}
      {shown.map((tag) => (
        <span key={tag.id} className="text-2xs px-1.5 py-0.5 rounded-md border truncate max-w-[100px]" style={{ borderColor: `${tag.color}55`, backgroundColor: `${tag.color}12`, color: tag.color }} title={tag.name}>
          {tag.name}
        </span>
      ))}
      {tags.length > shown.length && <span className="text-2xs text-ink-faint flex items-center gap-0.5"><Tags size={9} />+{tags.length - shown.length}</span>}
    </span>
  );
}
