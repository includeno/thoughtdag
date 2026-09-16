import type { EditMode } from '../../lib/edit-mode';
import { useT } from '../../i18n';

export default function EditModeSelect({ value, onChange, disabled = false }: {
  value: EditMode;
  onChange: (mode: EditMode) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <span className="inline-flex flex-col gap-1">
    <select
      aria-label={t('editMode.label')}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as EditMode)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      className="nodrag nopan text-xs bg-card border border-line rounded-lg px-2 py-1 text-ink disabled:opacity-50"
    >
      <optgroup label={t('editMode.manualGroup')}>
        <option value="manual">{t('editMode.manual')}</option>
        <option value="manual-detail">{t('editMode.structured')}</option>
      </optgroup>
      <optgroup label={t('editMode.aiGroup')}>
        <option value="ai">{t('editMode.ai')}</option>
      </optgroup>
    </select>
    <span className="text-2xs text-ink-faint">{t(value === 'manual' ? 'editMode.manualContext' : value === 'manual-detail' ? 'editMode.structuredContext' : 'editMode.aiContext')}</span>
    </span>
  );
}
