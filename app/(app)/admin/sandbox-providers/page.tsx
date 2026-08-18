import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { loadSandboxProvidersAdmin } from './load-admin';
import SandboxProvidersAdmin from './SandboxProvidersAdmin';

export default async function AdminSandboxProvidersPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');
  const initial = await loadSandboxProvidersAdmin();
  return <SandboxProvidersAdmin initial={initial} />;
}
