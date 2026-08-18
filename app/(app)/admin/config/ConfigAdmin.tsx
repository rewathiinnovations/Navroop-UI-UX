'use client';

import { useMemo, useState } from 'react';
import {
  Archive,
  Boxes,
  Eye,
  EyeOff,
  HardDrive,
  Mail,
  Plug,
  Sparkles,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import StatusBanner from '@/components/admin/StatusBanner';
import StudioButton from '@/components/app/studio/StudioButton';
import type { DescribedSetting, SettingSource } from '@/lib/settings/resolve';
import { cn } from '@/utils/cn';

type Group = { id: string; label: string; blurb: string };
type Bootstrap = { name: string; help: string; present: boolean };
type Check = { label: string; ok: boolean; depth: 'live' | 'local'; message: string };

const GROUP_ICON: Record<string, LucideIcon> = {
  connectors: Plug,
  ai: Sparkles,
  tooling: Boxes,
  email: Mail,
  storage: HardDrive,
  backups: Archive,
  app: SlidersHorizontal,
};

const SOURCE_LABEL: Record<SettingSource, string> = {
  db: 'Set here',
  env: 'From environment',
  fallback: 'Default',
  unset: 'Not set',
};

const SOURCE_DOT: Record<SettingSource, string> = {
  db: 'bg-[var(--studio-accent)]',
  env: 'bg-[var(--studio-muted)]',
  fallback: 'bg-[var(--studio-faint)]',
  unset: 'bg-transparent ring-1 ring-inset ring-[var(--studio-faint)]',
};

function SourceBadge({ source }: { source: SettingSource }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-6 rounded-full border border-[var(--studio-line)] px-8 py-3 text-[11px] text-[var(--studio-muted)]">
      <span className={cn('size-6 shrink-0 rounded-full', SOURCE_DOT[source])} aria-hidden />
      {SOURCE_LABEL[source]}
    </span>
  );
}

function SettingRow({
  setting,
  draft,
  onChange,
}: {
  setting: DescribedSetting;
  draft: string | undefined;
  onChange: (key: string, value: string) => void;
}) {
  const id = `setting-${setting.key.replace(/\./g, '-')}`;
  const secret = setting.kind === 'secret';
  const edited = draft !== undefined;
  const [revealed, setRevealed] = useState(false);
  // A secret is never sent to the browser, so the field starts empty and its
  // placeholder carries the mask. Typing replaces it; leaving it alone keeps
  // whatever is stored.
  const value = edited ? draft : secret ? '' : (setting.value ?? '');

  return (
    <div className="border-b border-[var(--studio-line)] py-16 last:border-b-0 last:pb-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <label htmlFor={id} className="text-[14px] font-medium text-[var(--studio-fg)]">
          {setting.label}
        </label>
        <SourceBadge source={setting.source} />
      </div>

      <p className="mt-4 max-w-[70ch] text-[13px] leading-5 text-[var(--studio-muted)]">
        {setting.help}
      </p>

      <div className="mt-10 flex flex-wrap items-center gap-8">
        {setting.kind === 'select' ? (
          <select
            id={id}
            value={value}
            onChange={(event) => onChange(setting.key, event.target.value)}
            className="h-40 min-w-[220px] rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] px-12 text-[14px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          >
            {(setting.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="relative w-full max-w-[420px]">
            <input
              id={id}
              type={
                secret && !revealed ? 'password' : setting.kind === 'number' ? 'number' : 'text'
              }
              inputMode={setting.kind === 'number' ? 'numeric' : undefined}
              autoComplete="off"
              spellCheck={false}
              value={value}
              placeholder={secret ? (setting.masked ?? 'Not set') : setting.placeholder}
              onChange={(event) => onChange(setting.key, event.target.value)}
              className={cn(
                'h-40 w-full rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] px-12 text-[14px] text-[var(--studio-fg)] placeholder:text-[var(--studio-faint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
                secret && 'pr-40',
              )}
            />
            {secret && (
              <button
                type="button"
                onClick={() => setRevealed((prev) => !prev)}
                aria-label={revealed ? 'Hide value' : 'Show value'}
                aria-pressed={revealed}
                className="absolute inset-y-0 right-0 flex w-36 items-center justify-center text-[var(--studio-faint)] transition-colors duration-150 hover:text-[var(--studio-muted)]"
              >
                {revealed ? (
                  <EyeOff className="size-15" aria-hidden />
                ) : (
                  <Eye className="size-15" aria-hidden />
                )}
              </button>
            )}
          </div>
        )}

        {setting.source === 'db' && !edited && (
          <StudioButton type="button" variant="danger" onClick={() => onChange(setting.key, '')}>
            Clear
          </StudioButton>
        )}
      </div>

      {edited && draft === '' && setting.source === 'db' && (
        <p className="mt-8 text-[12px] text-[var(--studio-muted)]">
          Saving will remove the stored value
          {setting.envName ? `, falling back to ${setting.envName} if it is set.` : '.'}
        </p>
      )}
    </div>
  );
}

export default function ConfigAdmin({
  initialGroups,
  initialSettings,
  initialBootstrap,
}: {
  initialGroups: Group[];
  initialSettings: DescribedSetting[];
  initialBootstrap: Bootstrap[];
}) {
  const [groups] = useState(initialGroups);
  const [settings, setSettings] = useState(initialSettings);
  const [bootstrap] = useState(initialBootstrap);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Check[]>>({});

  const byGroup = useMemo(() => {
    const map = new Map<string, DescribedSetting[]>();
    for (const setting of settings) {
      const list = map.get(setting.group) ?? [];
      list.push(setting);
      map.set(setting.group, list);
    }
    return map;
  }, [settings]);

  const visibleGroups = useMemo(
    () => groups.filter((group) => (byGroup.get(group.id) ?? []).length > 0),
    [groups, byGroup],
  );

  const configuredCount = useMemo(
    () => settings.filter((setting) => setting.configured).length,
    [settings],
  );

  const dirtyCount = Object.keys(drafts).length;

  const onChange = (key: string, value: string) => {
    setSaved(null);
    setDrafts((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          values: Object.entries(drafts).map(([key, value]) => ({ key, value })),
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        saved?: number;
        settings?: DescribedSetting[];
      };
      if (!response.ok) {
        setError(data.error || 'Could not save settings');
        return;
      }
      if (data.settings) setSettings(data.settings);
      setDrafts({});
      setSaved(data.saved ?? 0);
    } catch {
      setError('Could not reach the server');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (group: string) => {
    setTesting(group);
    setError(null);
    try {
      const response = await fetch('/api/admin/settings/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group }),
      });
      const data = (await response.json()) as { error?: string; checks?: Check[] };
      if (!response.ok) {
        setError(data.error || 'Test failed');
        return;
      }
      setResults((prev) => ({ ...prev, [group]: data.checks ?? [] }));
    } catch {
      setError('Could not reach the server');
    } finally {
      setTesting(null);
    }
  };

  return (
    <AdminPage
      icon="config"
      title="Configuration"
      description="Everything this installation needs in order to work. Values saved here are stored encrypted in the database and take effect immediately — there is no need to edit environment files or restart the server."
      actions={
        <StudioButton
          type="button"
          disabled={saving || dirtyCount === 0}
          onClick={() => void save()}
        >
          {saving
            ? 'Saving…'
            : dirtyCount > 0
              ? `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`
              : 'Save'}
        </StudioButton>
      }
    >
      <p className="text-[13px] text-[var(--studio-muted)]">
        {configuredCount} of {settings.length} settings configured.
      </p>

      <nav
        aria-label="Jump to a settings group"
        className="flex flex-wrap gap-6 border-b border-[var(--studio-line)] pb-16"
      >
        {visibleGroups.map((group) => {
          const Icon = GROUP_ICON[group.id] ?? SlidersHorizontal;
          return (
            <a
              key={group.id}
              href={`#${group.id}`}
              className="inline-flex items-center gap-6 rounded-full border border-[var(--studio-line)] px-10 py-6 text-[12px] text-[var(--studio-muted)] transition-colors duration-150 hover:border-[var(--studio-line-strong)] hover:text-[var(--studio-fg)]"
            >
              <Icon className="size-12" aria-hidden />
              {group.label}
            </a>
          );
        })}
      </nav>

      {error && <StatusBanner tone="error">{error}</StatusBanner>}
      {saved !== null && (
        <StatusBanner tone="success">
          {saved === 0 ? 'Nothing changed.' : `Saved ${saved} setting${saved === 1 ? '' : 's'}.`}
        </StatusBanner>
      )}

      {visibleGroups.map((group) => {
        const rows = byGroup.get(group.id) ?? [];
        const checks = results[group.id];
        const Icon = GROUP_ICON[group.id] ?? SlidersHorizontal;
        return (
          <AdminCard
            key={group.id}
            id={group.id}
            title={group.label}
            description={group.blurb}
            icon={<Icon className="size-14" aria-hidden />}
            actions={
              <StudioButton
                type="button"
                variant="ghost"
                disabled={testing === group.id}
                onClick={() => void runTest(group.id)}
              >
                {testing === group.id ? 'Testing…' : 'Test'}
              </StudioButton>
            }
          >
            {checks && (
              <div className="mb-16 space-y-8">
                {checks.map((check) => (
                  <div
                    key={check.label}
                    className="flex items-start gap-10 rounded-10 border border-[var(--studio-line)] px-12 py-10 text-[13px]"
                  >
                    <span
                      className={cn(
                        'mt-1 inline-block size-8 shrink-0 rounded-full',
                        check.ok ? 'bg-[var(--studio-fg)]' : 'bg-[var(--studio-danger)]',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className="font-medium text-[var(--studio-fg)]">{check.label}</span>
                      <span className="text-[var(--studio-muted)]"> — {check.message}</span>
                      {check.depth === 'local' && (
                        <span className="text-[var(--studio-faint)]">
                          {' '}
                          (not verified against the service)
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div>
              {rows.map((setting) => (
                <SettingRow
                  key={setting.key}
                  setting={setting}
                  draft={drafts[setting.key]}
                  onChange={onChange}
                />
              ))}
            </div>
          </AdminCard>
        );
      })}

      <AdminCard
        title="Set on the server"
        description="These are read before the database is available, so they cannot be managed here. They are listed so you can see the whole picture in one place."
      >
        <div className="space-y-12">
          {bootstrap.map((row) => (
            <div key={row.name} className="flex flex-wrap items-start justify-between gap-8">
              <div className="min-w-0">
                <p className="font-mono text-[13px] text-[var(--studio-fg)]">{row.name}</p>
                <p className="mt-2 max-w-[70ch] text-[12px] leading-5 text-[var(--studio-muted)]">
                  {row.help}
                </p>
              </div>
              <SourceBadge source={row.present ? 'env' : 'unset'} />
            </div>
          ))}
        </div>
      </AdminCard>
    </AdminPage>
  );
}
