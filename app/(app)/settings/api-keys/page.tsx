'use client';

import { FormEvent, useEffect, useState } from 'react';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import PageTabs from '@/components/app/studio/PageTabs';
import ConfirmAction from '@/components/admin/ConfirmAction';
import { useAuth } from '@/components/app/auth/AuthProvider';
import { notify } from '@/lib/notify';
import {
  deleteApiKey,
  deleteOrgApiKey,
  listPersonalApiKeys,
  setOrgApiKey,
  setPersonalApiKey,
} from '@/lib/api-keys/actions';

type PersonalKey = {
  provider: string;
  label: string;
  last4: string | null;
  hasOrgDefault?: boolean;
  /** A row for a provider that is no longer offered — removable, not editable (F-072). */
  legacy?: boolean;
};

type OrgKey = {
  provider: string;
  label: string;
  last4: string | null;
  legacy?: boolean;
};

const LEGACY_HINT =
  'No longer offered. This stored key still overrides the workspace configuration — remove it unless that is deliberate.';

function statusLabel(key: PersonalKey) {
  if (key.last4) return `••••${key.last4}`;
  return key.hasOrgDefault ? 'Using team default' : 'No default set';
}

export default function ApiKeysPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [keys, setKeys] = useState<PersonalKey[]>([]);
  const [orgKeys, setOrgKeys] = useState<OrgKey[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [orgDrafts, setOrgDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  /**
   * The server renders this page with no session, so it never emits the
   * admin-only section below. Showing that section the moment `isAdmin` flips
   * put it into the tree while React was still hydrating, which React reports
   * as a hydration failure (#418) and recovers from by re-rendering the tree.
   * It only bit on a cold server, where the gap between the HTML arriving and
   * hydration finishing is wide enough for the session fetch to land inside
   * it — invisible in dev and on warm reloads.
   *
   * Waiting for the team defaults themselves puts this section on the same
   * footing as the personal keys above, which have always appeared after
   * their own round trip without upsetting hydration.
   */
  const [orgLoaded, setOrgLoaded] = useState(false);

  const loadPersonal = async () => {
    const result = await listPersonalApiKeys();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setKeys(result.data.keys);
  };

  const loadOrg = async () => {
    const response = await fetch('/api/admin/api-keys');
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || 'Could not load team defaults');
      return;
    }
    setOrgKeys(data.keys || []);
    setOrgLoaded(true);
  };

  useEffect(() => {
    void loadPersonal();
  }, []);

  useEffect(() => {
    if (isAdmin) void loadOrg();
  }, [isAdmin]);

  const savePersonal = async (event: FormEvent, provider: string) => {
    event.preventDefault();
    const secret = drafts[provider]?.trim();
    if (!secret) return;
    setSaving(`personal:${provider}`);
    try {
      const result = await setPersonalApiKey(provider, secret);
      if (!result.ok) {
        notify.error(result.error, { key: `key-${provider}` });
        return;
      }
      setDrafts((current) => ({ ...current, [provider]: '' }));
      await loadPersonal();
      notify.success(`${provider} key saved.`, { key: `key-${provider}` });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not save the key', key: `key-${provider}` });
    } finally {
      setSaving(null);
    }
  };

  const removePersonal = async (provider: string) => {
    setSaving(`remove:${provider}`);
    try {
      const result = await deleteApiKey(provider);
      if (!result.ok) {
        notify.error(result.error, { key: `key-${provider}` });
        return;
      }
      await loadPersonal();
      notify.success(`${provider} key removed.`, { key: `key-${provider}` });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not remove the key', key: `key-${provider}` });
    } finally {
      setSaving(null);
    }
  };

  const saveOrg = async (event: FormEvent, provider: string) => {
    event.preventDefault();
    const secret = orgDrafts[provider]?.trim();
    if (!secret) return;
    setSaving(`org:${provider}`);
    try {
      const result = await setOrgApiKey(provider, secret);
      if (!result.ok) {
        notify.error(result.error, { key: `org-key-${provider}` });
        return;
      }
      setOrgDrafts((current) => ({ ...current, [provider]: '' }));
      await Promise.all([loadOrg(), loadPersonal()]);
      notify.success(`Team default for ${provider} saved.`, { key: `org-key-${provider}` });
    } catch (cause) {
      notify.error(cause, {
        fallback: 'Could not save the team default',
        key: `org-key-${provider}`,
      });
    } finally {
      setSaving(null);
    }
  };

  const removeOrg = async (provider: string) => {
    setSaving(`org-remove:${provider}`);
    try {
      const result = await deleteOrgApiKey(provider);
      if (!result.ok) {
        notify.error(result.error, { key: `org-key-${provider}` });
        return;
      }
      await Promise.all([loadOrg(), loadPersonal()]);
      notify.success(`Team default for ${provider} removed.`, { key: `org-key-${provider}` });
    } catch (cause) {
      notify.error(cause, {
        fallback: 'Could not remove the team default',
        key: `org-key-${provider}`,
      });
    } finally {
      setSaving(null);
    }
  };

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[720px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
          Settings
        </h1>
        <PageTabs
          items={[
            { href: '/settings/profile', label: 'Profile' },
            { href: '/settings/api-keys', label: 'API Keys', active: true },
            { href: '/settings/skills', label: 'Skills' },
            { href: '/settings/usage', label: 'Usage' },
          ]}
        />
        <p className="mb-24 text-[14px] leading-6 text-[var(--studio-muted)]">
          Personal keys override team defaults for your account. Only the last four characters are
          stored in the UI.
        </p>
        {error && (
          <p className="mb-16 text-[13px] text-[var(--studio-danger)]" role="alert">
            {error}
          </p>
        )}

        <h2 className="mb-12 text-[18px] font-medium text-[var(--studio-fg)]">Your keys</h2>
        <div className="space-y-16">
          {keys.map((key) => (
            <form
              key={key.provider}
              onSubmit={(event) => savePersonal(event, key.provider)}
              className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16"
            >
              <div className="mb-12 flex items-center justify-between gap-12">
                <div>
                  <h3 className="text-[15px] font-medium text-[var(--studio-fg)]">{key.label}</h3>
                  <p className="text-[12px] text-[var(--studio-muted)]">
                    {key.legacy ? LEGACY_HINT : statusLabel(key)}
                  </p>
                </div>
                {/* Remove dropped a credential the member then has to go
                    re-mint, on a single click (F-422). */}
                {key.last4 && (
                  <ConfirmAction
                    label="Remove"
                    title={`Remove your ${key.label} key?`}
                    body={
                      key.hasOrgDefault
                        ? `Your personal key is deleted and your requests fall back to the team default for ${key.label}. You will need the original key to set it again.`
                        : `Your personal key is deleted and ${key.label} stops working for your account until you paste a new one. You will need the original key to set it again.`
                    }
                    confirmLabel="Remove key"
                    busyLabel="Removing…"
                    disabled={saving === `remove:${key.provider}`}
                    onConfirm={() => removePersonal(key.provider)}
                  />
                )}
              </div>
              {!key.legacy && (
                <div className="flex flex-col gap-12 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <StudioField
                      id={`key-${key.provider}`}
                      label={`New ${key.label} key`}
                      type="password"
                      autoComplete="off"
                      value={drafts[key.provider] || ''}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [key.provider]: event.target.value }))
                      }
                      placeholder="Paste a key"
                    />
                  </div>
                  <StudioButton
                    type="submit"
                    variant="ghost"
                    disabled={saving === `personal:${key.provider}` || !drafts[key.provider]}
                  >
                    {saving === `personal:${key.provider}` ? 'Saving…' : 'Save'}
                  </StudioButton>
                </div>
              )}
            </form>
          ))}
        </div>

        {isAdmin && orgLoaded && (
          <section className="mt-40">
            <h2 className="mb-12 text-[18px] font-medium text-[var(--studio-fg)]">Team defaults</h2>
            <p className="mb-16 text-[13px] text-[var(--studio-muted)]">
              Members without a personal key use these defaults.
            </p>
            <div className="space-y-16">
              {orgKeys.map((key) => (
                <form
                  key={key.provider}
                  onSubmit={(event) => saveOrg(event, key.provider)}
                  className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16"
                >
                  <div className="mb-12 flex items-center justify-between gap-12">
                    <div>
                      <h3 className="text-[15px] font-medium text-[var(--studio-fg)]">
                        {key.label}
                      </h3>
                      <p className="text-[12px] text-[var(--studio-muted)]">
                        {key.legacy
                          ? LEGACY_HINT
                          : key.last4
                            ? `••••${key.last4}`
                            : 'No default set'}
                      </p>
                    </div>
                    {/* Workspace-wide blast radius: every member without a
                        personal key loses this provider at once (F-422). */}
                    {key.last4 && (
                      <ConfirmAction
                        label="Remove"
                        title={`Remove the team default for ${key.label}?`}
                        body={`Every member without their own ${key.label} key loses access to it immediately. You will need the original key to set the default again.`}
                        confirmLabel="Remove default"
                        busyLabel="Removing…"
                        disabled={saving === `org-remove:${key.provider}`}
                        onConfirm={() => removeOrg(key.provider)}
                      />
                    )}
                  </div>
                  {!key.legacy && (
                    <div className="flex flex-col gap-12 sm:flex-row sm:items-end">
                      <div className="flex-1">
                        <StudioField
                          id={`org-key-${key.provider}`}
                          label={`Team ${key.label} key`}
                          type="password"
                          autoComplete="off"
                          value={orgDrafts[key.provider] || ''}
                          onChange={(event) =>
                            setOrgDrafts((current) => ({
                              ...current,
                              [key.provider]: event.target.value,
                            }))
                          }
                          placeholder="Paste a team default key"
                        />
                      </div>
                      <StudioButton
                        type="submit"
                        variant="ghost"
                        disabled={saving === `org:${key.provider}` || !orgDrafts[key.provider]}
                      >
                        {saving === `org:${key.provider}` ? 'Saving…' : 'Save'}
                      </StudioButton>
                    </div>
                  )}
                </form>
              ))}
            </div>
          </section>
        )}
      </main>
    </StudioShell>
  );
}
