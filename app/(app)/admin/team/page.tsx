import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { listTeam } from '@/lib/team/actions';
import TeamTable from './TeamTable';

export default async function AdminTeamPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');

  const result = await listTeam();
  if (!result.ok) redirect('/dashboard');

  return <TeamTable initialMembers={result.data.members} selfId={user.id} />;
}
