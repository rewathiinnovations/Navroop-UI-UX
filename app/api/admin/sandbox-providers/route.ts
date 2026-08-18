import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { writeAudit } from '@/lib/audit/log';
import { lastActiveDeactivateWarning } from '@/lib/sandbox/admin';
import {
  ADD_PROVIDER_LABEL,
  DEFAULT_ORDER_NOTE,
  FREE_FIRST_STRATEGY_HELP,
  LAST_ACTIVE_DEACTIVATE_WARNING,
  TEST_PROVIDER_LABEL,
  isSandboxDriver,
  type CreditType,
  type RoutingStrategy,
} from '@/lib/sandbox/provider';
import { capabilityMatrix, strategyOptions, toPublicProvider } from '@/lib/sandbox/public';
import { rankAndSelect, toCandidate } from '@/lib/sandbox/router';
import {
  countActiveProviders,
  encryptProviderSecrets,
  getRoutingStrategy,
  insertProviderConfig,
  listProviderConfigs,
  setRoutingStrategy,
} from '@/lib/sandbox/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const rows = await listProviderConfigs();
  const strategy = await getRoutingStrategy();
  let ordered = rows;
  let nextPickReason: string | null = null;
  try {
    const first = rankAndSelect({
      candidates: rows.map(toCandidate),
      strategy,
      estimateSeconds: 1,
    });
    nextPickReason = first.selectionReason ?? null;
    ordered = [rows.find((row) => row.id === first.id)!, ...rows.filter((row) => row.id !== first.id)];
  } catch {
    ordered = rows;
  }
  return NextResponse.json({
    providers: ordered.filter(Boolean).map(toPublicProvider),
    strategy,
    nextPickReason,
    strategies: strategyOptions(strategy),
    capabilities: capabilityMatrix(),
    labels: {
      addProvider: ADD_PROVIDER_LABEL,
      test: TEST_PROVIDER_LABEL,
      freeFirst: FREE_FIRST_STRATEGY_HELP,
      lastActive: LAST_ACTIVE_DEACTIVATE_WARNING,
      defaultOrder: DEFAULT_ORDER_NOTE,
    },
  });
}

export async function POST(request: Request) {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (typeof body.strategy === 'string') {
    const strategy = body.strategy as RoutingStrategy;
    if (!['free_first', 'priority', 'round_robin', 'cheapest'].includes(strategy)) {
      return NextResponse.json({ error: 'Unknown strategy' }, { status: 400 });
    }
    await setRoutingStrategy(strategy);
    await writeAudit({
      actorId: user.id,
      actorEmail: user.email || 'admin',
      action: 'sandbox_provider.strategy',
      after: { strategy },
    });
    return NextResponse.json({ ok: true, strategy });
  }

  const driver = String(body.driver || '');
  if (!isSandboxDriver(driver)) {
    return NextResponse.json({ error: 'Driver must be e2b, modal, or daytona' }, { status: 400 });
  }
  const name = String(body.name || '').trim();
  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  const creditType = String(body.creditType || 'one_time') as CreditType;
  const secrets =
    driver === 'modal'
      ? { tokenId: String(body.tokenId || '').trim(), tokenSecret: String(body.tokenSecret || '').trim() }
      : { apiKey: String(body.apiKey || '').trim(), apiUrl: body.apiUrl ? String(body.apiUrl) : undefined };
  // A row saved without its credential fails every boot with the provider's
  // confusing server-side 401 ("authorization header is missing"). Refuse it
  // here, where the admin can still see which field is empty — six blank E2B
  // rows had accumulated this way.
  if (driver === 'modal') {
    if (!('tokenId' in secrets) || !secrets.tokenId || !secrets.tokenSecret) {
      return NextResponse.json(
        { error: 'Modal needs both a token ID and a token secret' },
        { status: 400 },
      );
    }
  } else if (!('apiKey' in secrets) || !secrets.apiKey) {
    return NextResponse.json(
      { error: `${driver === 'e2b' ? 'E2B' : 'Daytona'} needs an API key` },
      { status: 400 },
    );
  }
  const row = await insertProviderConfig({
    id: randomUUID(),
    name,
    driver,
    secrets: encryptProviderSecrets(secrets),
    creditType,
    creditTotalUsd: body.creditTotalUsd == null ? null : Number(body.creditTotalUsd),
    creditRemainingUsd: body.creditRemainingUsd == null ? (body.creditTotalUsd == null ? null : Number(body.creditTotalUsd)) : Number(body.creditRemainingUsd),
    creditResetsAt: body.creditResetsAt ? new Date(String(body.creditResetsAt)) : null,
    priority: body.priority == null ? 100 : Number(body.priority),
    weight: body.weight == null ? 1 : Number(body.weight),
    config: {
      cpu: body.cpu == null ? 1 : Number(body.cpu),
      memoryGiB: body.memoryGiB == null ? 1 : Number(body.memoryGiB),
      region: body.region ? String(body.region) : undefined,
      timeoutMs: body.timeoutMs == null ? 300_000 : Number(body.timeoutMs),
    },
  });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email || 'admin',
    action: 'sandbox_provider.create',
    targetType: 'SandboxProviderConfig',
    targetId: row?.id,
    after: { name, driver, creditType },
  });
  return NextResponse.json({ provider: row ? toPublicProvider(row) : null });
}

export async function PATCH(request: Request) {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { order?: string[] };
  if (!Array.isArray(body.order)) {
    return NextResponse.json({ error: 'order is required' }, { status: 400 });
  }
  const { updateProviderConfig, getProviderConfig } = await import('@/lib/sandbox/store');
  let priority = 10;
  for (const id of body.order) {
    const row = await getProviderConfig(id);
    if (!row) continue;
    await updateProviderConfig(id, { priority });
    priority += 10;
  }
  return NextResponse.json({ ok: true });
}

export { lastActiveDeactivateWarning };
