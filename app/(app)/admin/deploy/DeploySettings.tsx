'use client';

import { FormEvent, useState } from 'react';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import PageTabs from '@/components/app/studio/PageTabs';
import { saveDeploySettings, testDeployConnection } from '@/lib/coolify/actions';

type DeployState = {
  baseUrl: string;
  last4: string | null;
  tokenSource: 'env' | 'stored' | 'none';
  host: string;
  configured: boolean;
};

function tokenLabel(state: DeployState) {
  if (!state.last4) return 'No token saved';
  const mask = `••••${state.last4}`;
  if (state.tokenSource === 'env') return `${mask} (from environment)`;
  return mask;
}

export default function DeploySettings({ initial }: { initial: DeployState }) {
  const [state, setState] = useState(initial);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('save');
    setError('');
    setMessage('');
    try {
      const result = await saveDeploySettings({ baseUrl, token });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState(result.data);
      setToken('');
      setMessage(result.data.last4 ? `Token stored ••••${result.data.last4}` : 'Base URL saved');
    } finally {
      setBusy(null);
    }
  };

  const onTest = async () => {
    setBusy('test');
    setError('');
    setMessage('');
    try {
      const result = await testDeployConnection();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const version = result.data.version ? ` ${result.data.version}` : '';
      setMessage(`Connection ok (${result.data.endpoint}${version})`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[720px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">Admin</h1>
        <PageTabs
          items={[
            { href: '/admin/team', label: 'Team' },
            { href: '/admin/usage', label: 'Usage' },
            { href: '/admin/quality', label: 'Quality' },
            { href: '/admin/jobs', label: 'Jobs' },
            { href: '/admin/backups', label: 'Backups' },
            { href: '/admin/audit', label: 'Audit' },
            { href: '/admin/integrations', label: 'Integrations' },
            { href: '/admin/deploy', label: 'Deploy', active: true },
            { href: '/admin/plans', label: 'Plans' },
            { href: '/admin/workspace', label: 'Workspace' },
            { href: '/admin/servers', label: 'Servers' },
          ]}
        />

        <p className="mb-24 text-[14px] leading-6 text-[var(--studio-muted)]">
          Legacy Coolify token page. Prefer{' '}
          <a href="/admin/integrations" className="text-[var(--studio-accent)]">
            /admin/integrations
          </a>{' '}
          — publish reads the connected Coolify integration, not env vars.
        </p>

        <div className="mb-16 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16">
          <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">Coolify host</p>
          <p className="mt-6 text-[15px] font-medium text-[var(--studio-fg)]">{state.host}</p>
          <p className="mt-4 text-[13px] text-[var(--studio-muted)]">{tokenLabel(state)}</p>
        </div>

        {error && (
          <p className="mb-16 text-[13px] text-[var(--studio-danger)]" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="mb-16 text-[13px] text-[var(--studio-muted)]" role="status">
            {message}
          </p>
        )}

        <form
          onSubmit={onSave}
          className="space-y-16 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16"
        >
          <StudioField
            id="coolify-base-url"
            label="Coolify base URL"
            type="url"
            autoComplete="off"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://coolify.navroop.app"
            required
          />
          <StudioField
            id="coolify-api-token"
            label="API token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={state.last4 ? `Replace token (••••${state.last4})` : 'Paste a Coolify API token'}
          />
          <div className="flex flex-wrap gap-8">
            <StudioButton type="submit" variant="primary" disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </StudioButton>
            <StudioButton type="button" variant="ghost" disabled={busy !== null} onClick={onTest}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </StudioButton>
          </div>
        </form>
      </main>
    </StudioShell>
  );
}
