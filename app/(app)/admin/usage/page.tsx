import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import UsageDashboard from './UsageDashboard';

export default async function AdminUsagePage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');
  return <UsageDashboard />;
}
