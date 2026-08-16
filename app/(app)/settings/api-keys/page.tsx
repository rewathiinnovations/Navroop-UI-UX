'use client';

import { FormEvent, useEffect, useState } from 'react';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import PageTabs from '@/components/app/studio/PageTabs';
import { useAuth } from '@/components/app/auth/AuthProvider';
import { deleteApiKey, listPersonalApiKeys, setOrgApiKey, setPersonalApiKey } from '@/lib/api-keys/actions';

type PersonalKey = {
  provider: string;
  label: string;
  last4: string | null;
  hasOrgDefault: boolean;
};

type OrgKey = {
  provider: string;
  label: string;
  last4: string | null;
};

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
    setError('');
    try {
      const result = await setPersonalApiKey(provider, secret);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDrafts((current) => ({ ...current, [provider]: '' }));
      await loadPersonal();
    } finally {
      setSaving(null);
    }
  };

  const removePersonal = async (provider: string) => {
    setSaving(`remove:${provider}`);
    setError('');
    try {
      const result = await deleteApiKey(provider);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await loadPersonal();
    } finally {
      setSaving(null);
    }
  };

  const saveOrg = async (event: FormEvent, provider: string) => {
    event.preventDefault();
    const secret = orgDrafts[provider]?.trim();
    if (!secret) return;
    setSaving(`org:${provider}`);
    setError('');
    try {
      const result = await setOrgApiKey(provider, secret);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOrgDrafts((current) => ({ ...current, [provider]: '' }));
      await Promise.all([loadOrg(), loadPersonal()]);
    } finally {
      setSaving(null);
    }
  };

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[720px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">Settings</h1>
        <PageTabs
          items={[
            { href: '/settings/profile', label: 'Profile' },
            { href: '/settings/api-keys', label: 'API Keys', active: true },
            { href: '/settings/skills', label: 'Skills' },
          ]}
        />
        <p className="mb-24 text-[14px] leading-6 text-[var(--studio-muted)]">
          Personal keys override team defaults for your account. Only the last four characters are stored in the UI.
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
                  <p className="text-[12px] text-[var(--studio-muted)]">{statusLabel(key)}</p>
                </div>
                {key.last4 && (
                  <StudioButton
                    type="button"
                    variant="danger"
                    disabled={saving === `remove:${key.provider}`}
                    onClick={() => removePersonal(key.provider)}
                  >
                    Remove
                  </StudioButton>
                )}
              </div>
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
            </form>
          ))}
        </div>

        {isAdmin && (
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
                  <div className="mb-12">
                    <h3 className="text-[15px] font-medium text-[var(--studio-fg)]">{key.label}</h3>
                    <p className="text-[12px] text-[var(--studio-muted)]">
                      {key.last4 ? `••••${key.last4}` : 'No default set'}
                    </p>
                  </div>
                  <div className="flex flex-col gap-12 sm:flex-row sm:items-end">
                    <div className="flex-1">
                      <StudioField
                        id={`org-key-${key.provider}`}
                        label={`Team ${key.label} key`}
                        type="password"
                        autoComplete="off"
                        value={orgDrafts[key.provider] || ''}
                        onChange={(event) =>
                          setOrgDrafts((current) => ({ ...current, [key.provider]: event.target.value }))
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
                </form>
              ))}
            </div>
          </section>
        )}
      </main>
    </StudioShell>
  );
}
