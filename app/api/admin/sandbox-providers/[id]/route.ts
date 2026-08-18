import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { writeAudit } from '@/lib/audit/log';
import { lastActiveDeactivateWarning } from '@/lib/sandbox/admin';
import { LAST_ACTIVE_DEACTIVATE_WARNING, isSandboxDriver } from '@/lib/sandbox/provider';
import { toPublicProvider } from '@/lib/sandbox/public';
import {
  countActiveProviders,
  deleteProviderConfig,
  encryptProviderSecrets,
  getProviderConfig,
  updateProviderConfig,
} from '@/lib/sandbox/store';
import { DRIVER_CAPABILITIES } from '@/lib/sandbox/provider';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await context.params;
  const row = await getProviderConfig(id);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (body.isActive === false) {
    const active = await countActiveProviders();
    const warning = lastActiveDeactivateWarning(row.isActive ? active : active + 1);
    if (warning && body.confirm !== true) {
      return NextResponse.json({ warning: LAST_ACTIVE_DEACTIVATE_WARNING, needsConfirm: true }, { status: 409 });
    }
  }

  const config = { ...row.config };
  if (body.cpu != null) config.cpu = Number(body.cpu);
  if (body.memoryGiB != null) config.memoryGiB = Number(body.memoryGiB);
  if (body.region != null) {
    const region = String(body.region);
    const allowed = DRIVER_CAPABILITIES[row.driver].regions;
    if (region && !allowed.includes(region)) {
      return NextResponse.json({ error: `Region ${region} is not valid for ${row.driver}` }, { status: 400 });
    }
    config.region = region;
  }
  if (body.timeoutMs != null) config.timeoutMs = Number(body.timeoutMs);

  let secrets: string | undefined;
  if (body.apiKey || body.tokenId || body.tokenSecret) {
    secrets = encryptProviderSecrets(
      row.driver === 'modal'
        ? { tokenId: String(body.tokenId || ''), tokenSecret: String(body.tokenSecret || '') }
        : { apiKey: String(body.apiKey || ''), apiUrl: body.apiUrl ? String(body.apiUrl) : undefined },
    );
  }

  const updated = await updateProviderConfig(id, {
    name: body.name != null ? String(body.name) : undefined,
    isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
    priority: body.priority != null ? Number(body.priority) : undefined,
    weight: body.weight != null ? Number(body.weight) : undefined,
    creditType: body.creditType != null && ['recurring_monthly', 'one_time', 'paid'].includes(String(body.creditType))
      ? (body.creditType as 'recurring_monthly' | 'one_time' | 'paid')
      : undefined,
    creditTotalUsd: body.creditTotalUsd === undefined ? undefined : body.creditTotalUsd == null ? null : Number(body.creditTotalUsd),
    creditRemainingUsd:
      body.creditRemainingUsd === undefined
        ? undefined
        : body.creditRemainingUsd == null
          ? null
          : Number(body.creditRemainingUsd),
    creditResetsAt: body.creditResetsAt === undefined ? undefined : body.creditResetsAt ? new Date(String(body.creditResetsAt)) : null,
    monthlyBudgetUsd: body.monthlyBudgetUsd === undefined ? undefined : body.monthlyBudgetUsd == null ? null : Number(body.monthlyBudgetUsd),
    monthlyMinutesLimit:
      body.monthlyMinutesLimit === undefined
        ? undefined
        : body.monthlyMinutesLimit == null
          ? null
          : Number(body.monthlyMinutesLimit),
    config,
    secrets,
  });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email || 'admin',
    action: 'sandbox_provider.update',
    targetType: 'SandboxProviderConfig',
    targetId: id,
    after: { isActive: body.isActive, name: body.name },
  });
  return NextResponse.json({ provider: updated ? toPublicProvider(updated) : null });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await context.params;
  const row = await getProviderConfig(id);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (row.isActive) {
    const active = await countActiveProviders();
    if (active <= 1) {
      return NextResponse.json({ warning: LAST_ACTIVE_DEACTIVATE_WARNING, needsConfirm: true }, { status: 409 });
    }
  }
  await deleteProviderConfig(id);
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email || 'admin',
    action: 'sandbox_provider.delete',
    targetType: 'SandboxProviderConfig',
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}

void isSandboxDriver;
