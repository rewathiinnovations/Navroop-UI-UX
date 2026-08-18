import Link from 'next/link';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import StatusBanner from '@/components/admin/StatusBanner';
import { ADMIN_NAV } from '@/components/admin/admin-nav';
import { listIntegrations } from '@/lib/integrations/store';
import { KIND_LABELS, type IntegrationKind } from '@/lib/integrations/types';
import { describeSettings } from '@/lib/settings/resolve';

type Attention = { text: string; href: string; cta: string };

/**
 * `/admin` used to redirect straight to the team list, so there was no place
 * that answered "is anything wrong?" or "where do I find X?". Both questions
 * are answered here, from data that already exists elsewhere in admin.
 */
async function collectAttention(): Promise<Attention[]> {
  const items: Attention[] = [];

  const [{ settings }, integrations] = await Promise.all([
    describeSettings(),
    listIntegrations().catch(() => []),
  ]);

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
  const attention = await collectAttention().catch(() => []);

  return (
    <AdminPage
      title="Admin"
      description="Settings and tools for running this installation. Everything here affects the whole workspace, not just your own account."
      width="wide"
    >
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
            <ul className="space-y-12">
              {group.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-[14px] font-medium text-[var(--studio-fg)] underline-offset-2 hover:underline"
                  >
                    {item.label}
                  </Link>
                  <p className="mt-2 text-[13px] leading-5 text-[var(--studio-muted)]">
                    {item.description}
                  </p>
                </li>
              ))}
            </ul>
          </AdminCard>
        ))}
      </div>
    </AdminPage>
  );
}
