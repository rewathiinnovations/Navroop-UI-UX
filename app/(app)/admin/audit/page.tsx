import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import AuditAdmin from './AuditAdmin';

export default async function AdminAuditPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');
  return <AuditAdmin />;
}
