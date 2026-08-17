import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { getDeploySettings } from '@/lib/coolify/actions';
import DeploySettings from './DeploySettings';

export default async function AdminDeployPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');

  const result = await getDeploySettings();
  if (!result.ok) redirect('/dashboard');

  return <DeploySettings initial={result.data} />;
}
