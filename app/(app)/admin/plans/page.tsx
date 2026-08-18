import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { getWorkspaceAdminSettings, listPlans } from '@/lib/plans/actions';
import PlansAdmin from './PlansAdmin';

export default async function AdminPlansPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');

  const [plans, workspace] = await Promise.all([listPlans(), getWorkspaceAdminSettings()]);
  if (!plans.ok || !workspace.ok) redirect('/dashboard');

  return <PlansAdmin initialPlans={plans.data.plans} assignedPlanId={workspace.data.planId} />;
}
