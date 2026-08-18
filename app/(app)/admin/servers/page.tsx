import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { listCoolifyServers } from '@/lib/coolify/server-actions';
import ServersAdmin from './ServersAdmin';

export default async function AdminServersPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');
  const result = await listCoolifyServers();
  if (!result.ok) redirect('/dashboard');
  return <ServersAdmin initial={result.data.servers} />;
}
