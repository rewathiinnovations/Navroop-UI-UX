import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { getBackupAdmin } from '@/lib/backup/admin';
import BackupsAdmin from './BackupsAdmin';

export default async function AdminBackupsPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');
  const initial = await getBackupAdmin();
  return <BackupsAdmin initial={initial} />;
}
