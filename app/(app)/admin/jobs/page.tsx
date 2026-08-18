import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import JobsAdmin from './JobsAdmin';

export default async function AdminJobsPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');
  return <JobsAdmin />;
}
