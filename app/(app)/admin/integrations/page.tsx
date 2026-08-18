import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { listPublicIntegrations } from '@/lib/integrations/public';
import IntegrationsAdmin from './IntegrationsAdmin';

export default async function AdminIntegrationsPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');
  const initial = await listPublicIntegrations();
  return <IntegrationsAdmin initial={initial} />;
}
