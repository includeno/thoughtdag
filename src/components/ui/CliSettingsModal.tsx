import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, SquareTerminal, X } from 'lucide-react';
import { CLI_COMMAND_GROUPS } from '../../../shared/cli-commands.mjs';
import { inspectCliControl, loadCliSettings, saveCliSettings, type CliControlInfo, type CliSettings } from '../../lib/cli-control';
import { toast, useUiStore } from '../../lib/ui-store';
import { useT, type MessageKey } from '../../i18n';

const GROUP_KEYS: Record<string, MessageKey> = {
  inspect: 'cli.groupInspect',
  projects: 'cli.groupProjects',
  nodes: 'cli.groupNodes',
  connections: 'cli.groupConnections',
  materials: 'cli.groupMaterials',
  generation: 'cli.groupGeneration',
  organize: 'cli.groupOrganize',
  transfer: 'cli.groupTransfer',
  delete: 'cli.groupDelete',
};

function GroupToggle({ checked, partial, danger, onChange }: {
  checked: boolean;
  partial: boolean;
  danger?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className={`w-4 h-4 rounded ${danger ? 'accent-red-600' : 'accent-accent'}`}
    />
  );
}

export default function CliSettingsModal() {
  const open = useUiStore((state) => state.cliSettingsOpen);
  const setOpen = useUiStore((state) => state.setCliSettingsOpen);
  const t = useT();
  const [settings, setSettings] = useState<CliSettings>(() => loadCliSettings());
  const [info, setInfo] = useState<CliControlInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSettings(loadCliSettings());
    setError('');
    void inspectCliControl().then(setInfo).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [open]);

  if (!open) return null;
  const selected = new Set(settings.permissions);
  const commandLine = info
    ? `node "${info.cliScript}" --session "${info.sessionFile}" status`
    : '';

  const toggleGroup = (commands: string[], checked: boolean) => {
    const next = new Set(settings.permissions);
    for (const command of commands) {
      if (checked) next.add(command);
      else next.delete(command);
    }
    setSettings({ ...settings, permissions: [...next] });
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await saveCliSettings(settings);
      setInfo(next);
      toast('success', t('cli.saved'));
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] bg-ink/25 backdrop-blur-[2px] flex items-center justify-center animate-fade-in" onClick={() => setOpen(false)}>
      <div className="bg-card border border-line rounded-2xl shadow-xl w-[680px] max-w-[calc(100vw-32px)] max-h-[86vh] flex flex-col" onClick={(event) => event.stopPropagation()} data-cli-settings>
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-line">
          <SquareTerminal size={17} strokeWidth={1.75} className="text-accent" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-ink">{t('cli.title')}</h2>
            <p className="text-2xs text-ink-faint mt-0.5">{t('cli.subtitle')}</p>
          </div>
          <button onClick={() => setOpen(false)} className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink hover:bg-wash"><X size={15} /></button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          <label className="flex items-start gap-3 bg-wash rounded-xl px-4 py-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
              className="w-4 h-4 mt-0.5 accent-accent"
              data-cli-enabled
            />
            <span>
              <span className="block text-xs font-semibold text-ink">{t('cli.allow')}</span>
              <span className="block text-2xs text-ink-muted leading-relaxed mt-1">{t('cli.allowHint')}</span>
            </span>
          </label>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-ink">{t('cli.permissions')}</h3>
              <span className="text-2xs text-ink-faint">{settings.permissions.length} / {CLI_COMMAND_GROUPS.reduce((sum, group) => sum + group.commands.length, 0)}</span>
            </div>
            <div className="space-y-2">
              {CLI_COMMAND_GROUPS.map((group) => {
                const count = group.commands.filter((command) => selected.has(command)).length;
                const all = count === group.commands.length;
                const partial = count > 0 && !all;
                return (
                  <div key={group.id} className={`rounded-xl border ${group.danger ? 'border-red-500/50 bg-red-500/[0.05]' : 'border-line bg-card'}`}>
                    <label className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer">
                      <GroupToggle checked={all} partial={partial} danger={group.danger} onChange={(checked) => toggleGroup(group.commands, checked)} />
                      <span className={`text-xs font-semibold flex-1 ${group.danger ? 'text-red-700' : 'text-ink'}`}>{t(GROUP_KEYS[group.id])}</span>
                      <span className={`text-2xs ${group.danger ? 'text-red-600' : 'text-ink-faint'}`}>{count}/{group.commands.length}</span>
                    </label>
                    {group.danger && (
                      <div className="mx-3 mb-2.5 flex gap-2 text-2xs leading-relaxed text-red-700">
                        <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {t('cli.deleteWarning')}
                      </div>
                    )}
                    <div className={`grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 pb-3 ${group.danger ? 'border-red-500/20' : ''}`}>
                      {group.commands.map((command) => (
                        <label key={command} className="flex items-center gap-2 min-w-0 cursor-pointer rounded-lg px-2 py-1.5 hover:bg-wash">
                          <input
                            type="checkbox"
                            checked={selected.has(command)}
                            onChange={(event) => toggleGroup([command], event.target.checked)}
                            className={`w-3.5 h-3.5 shrink-0 ${group.danger ? 'accent-red-600' : 'accent-accent'}`}
                          />
                          <code className={`text-2xs truncate ${group.danger ? 'text-red-700' : 'text-ink-muted'}`}>{command}</code>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {commandLine && (
            <div className="rounded-xl border border-line bg-wash px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-2xs font-medium text-ink-muted flex-1">{t('cli.readyCommand')}</span>
                <button
                  onClick={() => void navigator.clipboard.writeText(commandLine).then(() => toast('success', t('toast.copied')))}
                  className="text-ink-faint hover:text-accent"
                  title={t('cli.copyCommand')}
                ><Copy size={13} /></button>
              </div>
              <code className="block text-[10px] leading-relaxed text-ink break-all select-all">{commandLine}</code>
            </div>
          )}
          {error && <p className="text-2xs text-red-700 bg-red-500/10 rounded-lg px-3 py-2">{t('cli.unavailable')}: {error}</p>}
        </div>

        <div className="border-t border-line px-5 py-3 flex items-center justify-end gap-2">
          <button onClick={() => setOpen(false)} className="text-xs px-4 py-2 rounded-lg text-ink-muted hover:bg-wash">{t('common.cancel')}</button>
          <button onClick={() => void save()} disabled={busy} className="text-xs px-4 py-2 rounded-lg bg-accent text-white disabled:opacity-40" data-cli-save>{busy ? t('cli.saving') : t('common.save')}</button>
        </div>
      </div>
    </div>
  );
}

