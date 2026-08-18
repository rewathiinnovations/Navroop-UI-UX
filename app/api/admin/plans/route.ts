import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { assignDefaultWorkspacePlan, createPlan, listPlans, updatePlan } from '@/lib/plans/actions';

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const result = await listPlans();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}

export async function POST(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.assignPlanId === 'string') {
    const assigned = await assignDefaultWorkspacePlan(body.assignPlanId);
    if (!assigned.ok)
      return NextResponse.json({ error: assigned.error }, { status: assigned.status });
    return NextResponse.json(assigned.data);
  }
  const created = await createPlan({
    key: String(body.key || ''),
    name: String(body.name || ''),
    monthlyCredits: Number(body.monthlyCredits ?? 100),
    maxProjects: Number(body.maxProjects ?? 5),
    maxLiveSites: Number(body.maxLiveSites ?? 1),
    maxPreviewSites: Number(body.maxPreviewSites ?? 3),
    maxMembers: Number(body.maxMembers ?? 2),
    checkpointRetentionDays: Number(body.checkpointRetentionDays ?? 7),
    storageBytesLimit: String(body.storageBytesLimit ?? 524288000),
    allowCustomDomain: body.allowCustomDomain === true,
    allowGithubSync: body.allowGithubSync === true,
    isActive: body.isActive !== false,
    maxTokensPerJob: typeof body.maxTokensPerJob === 'number' ? body.maxTokensPerJob : undefined,
    maxFilesPerJob: typeof body.maxFilesPerJob === 'number' ? body.maxFilesPerJob : undefined,
    maxOutputBytesPerJob:
      typeof body.maxOutputBytesPerJob === 'number' ? body.maxOutputBytesPerJob : undefined,
  });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status });
  return NextResponse.json({ plan: created.data });
}

export async function PATCH(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(body.id || '');
  if (!id) return NextResponse.json({ error: 'Plan id is required' }, { status: 400 });
  const updated = await updatePlan(id, {
    name: typeof body.name === 'string' ? body.name : undefined,
    isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
    isDefault: typeof body.isDefault === 'boolean' ? body.isDefault : undefined,
    monthlyCredits: typeof body.monthlyCredits === 'number' ? body.monthlyCredits : undefined,
    maxProjects: typeof body.maxProjects === 'number' ? body.maxProjects : undefined,
    maxLiveSites: typeof body.maxLiveSites === 'number' ? body.maxLiveSites : undefined,
    maxPreviewSites: typeof body.maxPreviewSites === 'number' ? body.maxPreviewSites : undefined,
    maxMembers: typeof body.maxMembers === 'number' ? body.maxMembers : undefined,
    checkpointRetentionDays:
      typeof body.checkpointRetentionDays === 'number' ? body.checkpointRetentionDays : undefined,
    storageBytesLimit:
      typeof body.storageBytesLimit === 'string' || typeof body.storageBytesLimit === 'number'
        ? body.storageBytesLimit
        : undefined,
    allowCustomDomain:
      typeof body.allowCustomDomain === 'boolean' ? body.allowCustomDomain : undefined,
    allowGithubSync: typeof body.allowGithubSync === 'boolean' ? body.allowGithubSync : undefined,
    maxTokensPerJob: typeof body.maxTokensPerJob === 'number' ? body.maxTokensPerJob : undefined,
    maxFilesPerJob: typeof body.maxFilesPerJob === 'number' ? body.maxFilesPerJob : undefined,
    maxOutputBytesPerJob:
      typeof body.maxOutputBytesPerJob === 'number' ? body.maxOutputBytesPerJob : undefined,
  });
  if (!updated.ok) return NextResponse.json({ error: updated.error }, { status: updated.status });
  return NextResponse.json({ plan: updated.data });
}
