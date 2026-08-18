'use client';

import { useState } from 'react';
import Link from 'next/link';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import PageTabs from '@/components/app/studio/PageTabs';

export type PublicServer = {
  id: string;
  name: string;
  apiUrl: string;
  serverIp: string;
  projectUuid: string;
  isActive: boolean;
  maxDeployments: number;
  last4: string;
  deploymentCount: number;
};

const adminTabs = (active: string) => [
  { href: '/admin/team', label: 'Team', active: active === 'team' },
  { href: '/admin/usage', label: 'Usage', active: active === 'usage' },
  { href: '/admin/quality', label: 'Quality', active: active === 'quality' },
  { href: '/admin/jobs', label: 'Jobs', active: active === 'jobs' },
  { href: '/admin/backups', label: 'Backups', active: active === 'backups' },
  { href: '/admin/audit', label: 'Audit', active: active === 'audit' },
  { href: '/admin/integrations', label: 'Integrations', active: active === 'integrations' },
  { href: '/admin/deploy', label: 'Deploy', active: active === 'deploy' },
  { href: '/admin/servers', label: 'Servers', active: active === 'servers' },
  { href: '/admin/plans', label: 'Plans', active: active === 'plans' },
  { href: '/admin/workspace', label: 'Workspace', active: active === 'workspace' },
  { href: '/admin/sandbox-providers', label: 'Sandbox providers', active: active === 'sandbox-providers' },
];

export default function ServersAdmin({ initial }: { initial: PublicServer[] }) {
  const [servers, setServers] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const refresh = async () => {
    const response = await fetch('/api/admin/servers');
    const data = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(data.servers)) setServers(data.servers);
  };

  const test = async (id: string) => {
    setBusy(`test:${id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/admin/servers/${id}/test`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'Connection fail');
        return;
      }
      setMessage(`Connection ok${data.version ? ` (${data.version})` : ''}`);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (server: PublicServer) => {
    if (server.isActive && server.deploymentCount > 0) {
      const ok = window.confirm(
        `This server has ${server.deploymentCount} live deployments. Deactivate it? New publishes will not go here.`,
      );
      if (!ok) return;
    }
    setBusy(`active:${server.id}`);
    try {
      const response = await fetch(`/api/admin/servers/${server.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          server.isActive && server.deploymentCount > 0
            ? { forceDeactivate: true }
            : { isActive: !server.isActive },
        ),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'Update fail');
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const saveMax = async (id: string, maxDeployments: number) => {
    setBusy(`max:${id}`);
    try {
      const response = await fetch(`/api/admin/servers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDeployments }),
      });
      if (!response.ok) setError('Could not save the limit');
      else await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[960px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">Admin</h1>
        <PageTabs items={adminTabs('servers')} />

        {error && <p className="mb-12 text-[13px] text-[var(--studio-danger)]">{error}</p>}
        {message && <p className="mb-12 text-[13px] text-[var(--studio-muted)]">{message}</p>}

        <p className="mb-16 text-[13px] text-[var(--studio-muted)]">
          Servers are discovered from <Link href="/admin/integrations" className="text-[var(--studio-accent)]">/admin/integrations</Link>.
          This page is only for limits and the active toggle.
        </p>

        <div className="overflow-x-auto rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)]">
          <table className="w-full text-left text-[14px]">
            <thead className="border-b border-[var(--studio-line)] text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              <tr>
                <th className="px-16 py-12 font-medium">Name</th>
                <th className="px-16 py-12 font-medium">IP</th>
                <th className="px-16 py-12 font-medium">Token</th>
                <th className="px-16 py-12 font-medium">Deployments</th>
                <th className="px-16 py-12 font-medium">Status</th>
                <th className="px-16 py-12 font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.id} className="border-b border-[var(--studio-line)] last:border-0 align-top">
                  <td className="px-16 py-14">
                    <p className="font-medium">{server.name}</p>
                    <p className="text-[12px] text-[var(--studio-faint)]">{server.apiUrl}</p>
                  </td>
                  <td className="px-16 py-14 text-[var(--studio-muted)]">{server.serverIp}</td>
                  <td className="px-16 py-14 text-[13px]">••••{server.last4}</td>
                  <td className="px-16 py-14">
                    {server.deploymentCount} /
                    <input
                      type="number"
                      min={1}
                      defaultValue={server.maxDeployments}
                      className="ml-6 h-32 w-64 rounded-8 border border-[var(--studio-line)] px-6 text-[12px]"
                      onBlur={(event) => {
                        const value = Number(event.target.value);
                        if (value > 0 && value !== server.maxDeployments) void saveMax(server.id, value);
                      }}
                    />
                  </td>
                  <td className="px-16 py-14">{server.isActive ? 'Active' : 'Inactive'}</td>
                  <td className="px-16 py-14">
                    <div className="flex flex-col gap-6">
                      <StudioButton type="button" variant="ghost" disabled={busy === `test:${server.id}`} onClick={() => void test(server.id)}>
                        Test connection
                      </StudioButton>
                      <StudioButton type="button" variant="ghost" disabled={busy === `active:${server.id}`} onClick={() => void toggle(server)}>
                        {server.isActive ? 'Deactivate' : 'Activate'}
                      </StudioButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </StudioShell>
  );
}
