import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import HealthDashboard from './HealthDashboard';

export default async function AdminHealthPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');
  return <HealthDashboard />;
}
