import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { listWorkspaceDeployments } from '@/lib/publish/actions';
import DeploymentsList from './DeploymentsList';

export default async function DeploymentsPage() {
  const user = await getSessionUser();
  if (!user) redirect('/?auth=login&next=/deployments');
  const result = await listWorkspaceDeployments();
  if (!result.ok) redirect('/dashboard');
  return <DeploymentsList initial={result.data.deployments} />;
}
