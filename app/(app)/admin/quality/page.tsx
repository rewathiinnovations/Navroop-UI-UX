import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import QualityDashboard from './QualityDashboard';

export default async function AdminQualityPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');
  return <QualityDashboard />;
}
