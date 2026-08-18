import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { getWorkspaceAdminSettings } from '@/lib/plans/actions';
import WorkspaceAdmin from './WorkspaceAdmin';

export default async function AdminWorkspacePage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');

  const result = await getWorkspaceAdminSettings();
  if (!result.ok) redirect('/dashboard');

  return <WorkspaceAdmin initial={result.data} />;
}
