import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminIcon from '@/components/admin/AdminIcon';
import AdminPage from '@/components/admin/AdminPage';
import StatTile from '@/components/admin/StatTile';
import StatusBanner from '@/components/admin/StatusBanner';
import { ADMIN_NAV } from '@/components/admin/admin-nav';
import { prisma } from '@/lib/db';
import { listActiveJobs } from '@/lib/jobs/store';
import { listIntegrations } from '@/lib/integrations/store';
import { INTEGRATION_KINDS, KIND_LABELS, type IntegrationKind } from '@/lib/integrations/types';
import { describeSettings } from '@/lib/settings/resolve';
import { formatStorageBytes } from '@/lib/storage/format';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';

type Attention = { text: string; href: string; cta: string };

/**
 * `/admin` used to redirect straight to the team list, so there was no place
 * that answered "is anything wrong?" or "where do I find X?". Both questions
 * are answered here, from data that already exists elsewhere in admin.
 */
async function collectAttention(
  settings: Awaited<ReturnType<typeof describeSettings>>['settings'],
  integrations: Awaited<ReturnType<typeof listIntegrations>>,
): Promise<Attention[]> {
  const items: Attention[] = [];

  const aiConfigured = settings.some(
    (setting) => setting.group === 'ai' && setting.key.endsWith('.apiKey') && setting.configured,
  );
  if (!aiConfigured) {
    items.push({
      text: 'No AI provider key is configured, so generation cannot run.',
      href: '/admin/config#ai',
      cta: 'Add a key',
    });
  }

  const githubReady =
    settings.find((s) => s.key === 'github.oauth.clientId')?.configured &&
    settings.find((s) => s.key === 'github.oauth.clientSecret')?.configured;
  if (!githubReady) {
    items.push({
      text: 'GitHub sign-in for connectors is not configured, so the Connect button on the Connectors page cannot work.',
      href: '/admin/config#connectors',
      cta: 'Configure',
    });
  }

  for (const integration of integrations) {
    if (integration.lastError) {
      const label = KIND_LABELS[integration.kind as IntegrationKind] ?? integration.kind;
      items.push({
        text: `${label} reported a problem: ${integration.lastError}`,
        href: '/admin/integrations',
        cta: 'Review',
      });
    }
  }

  return items;
}

export default async function AdminHomePage() {
  const [{ settings }, integrations, memberCount, activeJobs, workspace] = await Promise.all([
    describeSettings(),
    listIntegrations().catch(() => []),
    prisma.user.count({ where: { isActive: true } }).catch(() => null),
    listActiveJobs().catch(() => []),
    prisma.workspace
      .findUnique({
        where: { id: WORKSPACE_ROW_ID },
        select: { storageBytes: true, storageLimitBytes: true },
      })
      .catch(() => null),
  ]);

  const attention = await collectAttention(settings, integrations).catch(() => []);
  const connectedCount = integrations.filter((row) => row.status === 'CONNECTED').length;
  const storageRatio =
    workspace?.storageLimitBytes && workspace.storageLimitBytes > 0
      ? Math.min(workspace.storageBytes / workspace.storageLimitBytes, 1)
      : null;

  return (
    <AdminPage
      icon="home"
      title="Admin"
      description="Settings and tools for running this installation. Everything here affects the whole workspace, not just your own account."
      width="wide"
    >
      <div className="grid gap-12 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={<AdminIcon name="team" className="size-16" />}
          value={memberCount ?? '—'}
          label="Active members"
          href="/admin/team"
        />
        <StatTile
          icon={<AdminIcon name="jobs" className="size-16" />}
          value={activeJobs.length}
          label="Jobs running now"
          href="/admin/jobs"
        />
        <StatTile
          icon={<AdminIcon name="integrations" className="size-16" />}
          value={`${connectedCount}/${INTEGRATION_KINDS.length}`}
          label="Integrations connected"
          href="/admin/integrations"
          tone={connectedCount === 0 ? 'warning' : 'default'}
        />
        <StatTile
          icon={<AdminIcon name="workspace" className="size-16" />}
          value={workspace ? formatStorageBytes(workspace.storageBytes) : '—'}
          label="Storage used"
          hint={storageRatio !== null ? `${Math.round(storageRatio * 100)}% of limit` : undefined}
          href="/admin/usage"
          tone={storageRatio !== null && storageRatio >= 0.9 ? 'warning' : 'default'}
        />
      </div>

      {attention.length === 0 ? (
        <StatusBanner tone="success">
          Nothing needs attention. Providers are configured and no integration is reporting an
          error.
        </StatusBanner>
      ) : (
        <div className="space-y-8">
          {attention.map((item) => (
            <StatusBanner
              key={item.text}
              tone="error"
              action={
                <Link
                  href={item.href}
                  className="text-[13px] font-medium text-[var(--studio-fg)] underline underline-offset-2"
                >
                  {item.cta}
                </Link>
              }
            >
              {item.text}
            </StatusBanner>
          ))}
        </div>
      )}

      <div className="grid gap-16 md:grid-cols-2">
        {ADMIN_NAV.filter((group) => group.group !== 'Overview').map((group) => (
          <AdminCard key={group.group} title={group.group}>
            <ul className="divide-y divide-[var(--studio-line)]">
              {group.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="group flex items-start gap-12 rounded-8 py-10 transition-colors duration-150 hover:bg-[var(--studio-surface-hover)]"
                  >
                    <span className="mt-0.5 inline-flex size-26 shrink-0 items-center justify-center rounded-8 bg-[var(--studio-bg)] text-[var(--studio-muted)]">
                      <AdminIcon name={item.icon} className="size-13" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-[14px] font-medium text-[var(--studio-fg)]">
                        {item.label}
                      </span>
                      <span className="block text-[13px] leading-5 text-[var(--studio-muted)]">
                        {item.description}
                      </span>
                    </span>
                    <ChevronRight
                      className="mt-1.5 size-14 shrink-0 text-[var(--studio-faint)] opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </AdminCard>
        ))}
      </div>
    </AdminPage>
  );
}
