'use client';

import { Server as ServerIcon } from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import StatusPill from '@/components/admin/StatusPill';
import AdminPage from '@/components/admin/AdminPage';
import { AdminTable, Td, Th, Tr } from '@/components/admin/AdminTable';
import { useState } from 'react';
import Link from 'next/link';
import StudioButton from '@/components/app/studio/StudioButton';
import ConfirmAction from '@/components/admin/ConfirmAction';
import { notify, toMessage } from '@/lib/notify';

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

export default function ServersAdmin({ initial }: { initial: PublicServer[] }) {
  const [servers, setServers] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = async () => {
    const response = await fetch('/api/admin/servers');
    const data = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(data.servers)) setServers(data.servers);
  };

  const test = async (id: string) => {
    setBusy(`test:${id}`);
    const toastId = notify.loading('Testing the connection…');
    try {
      const response = await fetch(`/api/admin/servers/${id}/test`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        notify.settle(toastId, 'error', data.error || 'The connection test failed');
        return;
      }
      notify.settle(toastId, 'success', `Connection ok${data.version ? ` (${data.version})` : ''}`);
    } catch (cause) {
      notify.settle(toastId, 'error', toMessage(cause, 'The connection test failed'));
    } finally {
      setBusy(null);
    }
  };

  // The confirm for a server with live deployments is ConfirmAction in the row,
  // like every other destructive admin action — not window.confirm.
  const toggle = async (server: PublicServer) => {
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
        notify.error(data.error || 'Could not update the server');
        return;
      }
      notify.success(server.isActive ? `${server.name} deactivated.` : `${server.name} activated.`);
      await refresh();
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not update the server' });
    } finally {
      setBusy(null);
    }
  };

  // Fired on blur of the inline limit input, where the toast is the only
  // confirmation the value was actually persisted.
  const saveMax = async (id: string, maxDeployments: number) => {
    setBusy(`max:${id}`);
    try {
      const response = await fetch(`/api/admin/servers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDeployments }),
      });
      if (!response.ok) {
        notify.error('Could not save the limit', { key: `server-max-${id}` });
        return;
      }
      notify.success(`Deployment limit set to ${maxDeployments}.`, { key: `server-max-${id}` });
      await refresh();
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not save the limit', key: `server-max-${id}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminPage
      icon="servers"
      title="Servers"
      description="The machines available to host published sites."
    >
      <AdminCard icon={<ServerIcon className="size-14" aria-hidden />} title="Servers">
        <p className="mb-16 text-[13px] text-[var(--studio-muted)]">
          Servers are discovered from{' '}
          <Link
            href="/admin/integrations"
            className="text-[var(--studio-accent)] underline-offset-2 hover:underline"
          >
            Admin → Integrations
          </Link>
          . This page is only for limits and the active toggle.
        </p>

        <AdminTable
          isEmpty={servers.length === 0}
          empty="No servers discovered yet. Connect Coolify in Admin → Integrations."
          head={
            <>
              <Th>Name</Th>
              <Th>IP</Th>
              <Th>Token</Th>
              <Th>Deployments</Th>
              <Th>Status</Th>
              <Th align="right"> </Th>
            </>
          }
        >
          {servers.map((server) => (
            <Tr key={server.id}>
              <Td>
                <p className="font-medium text-[var(--studio-fg)]">{server.name}</p>
                <p className="text-[12px] text-[var(--studio-faint)]">{server.apiUrl}</p>
              </Td>
              <Td muted>{server.serverIp}</Td>
              <Td mono muted>
                ••••{server.last4}
              </Td>
              <Td>
                <div className="flex items-center gap-6">
                  <span className="text-[var(--studio-fg)]">{server.deploymentCount}</span>
                  <span className="text-[var(--studio-faint)]">/</span>
                  <input
                    type="number"
                    min={1}
                    aria-label={`Max deployments for ${server.name}`}
                    defaultValue={server.maxDeployments}
                    className="h-32 w-64 rounded-8 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-6 text-[12px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      if (value > 0 && value !== server.maxDeployments)
                        void saveMax(server.id, value);
                    }}
                  />
                </div>
              </Td>
              <Td>
                <StatusPill tone={server.isActive ? 'positive' : 'neutral'}>
                  {server.isActive ? 'Active' : 'Inactive'}
                </StatusPill>
              </Td>
              <Td align="right">
                <div className="flex flex-wrap items-center justify-end gap-8">
                  <StudioButton
                    type="button"
                    variant="ghost"
                    disabled={busy === `test:${server.id}`}
                    onClick={() => void test(server.id)}
                  >
                    {busy === `test:${server.id}` ? 'Testing…' : 'Test connection'}
                  </StudioButton>
                  {server.isActive && server.deploymentCount > 0 ? (
                    <ConfirmAction
                      label="Deactivate"
                      title={`Deactivate ${server.name}?`}
                      body={`This server hosts ${server.deploymentCount} live ${
                        server.deploymentCount === 1 ? 'deployment' : 'deployments'
                      }. They keep running, but new publishes will not go here.`}
                      confirmLabel="Deactivate"
                      busyLabel="Deactivating…"
                      disabled={busy === `active:${server.id}`}
                      onConfirm={() => toggle(server)}
                    />
                  ) : (
                    <StudioButton
                      type="button"
                      variant={server.isActive ? 'danger' : 'ghost'}
                      disabled={busy === `active:${server.id}`}
                      onClick={() => void toggle(server)}
                    >
                      {server.isActive ? 'Deactivate' : 'Activate'}
                    </StudioButton>
                  )}
                </div>
              </Td>
            </Tr>
          ))}
        </AdminTable>
      </AdminCard>
    </AdminPage>
  );
}
