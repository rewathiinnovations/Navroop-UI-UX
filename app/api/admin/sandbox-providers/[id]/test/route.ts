import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { fieldsAfterProviderTest, formatProviderTestResult } from '@/app/(app)/admin/sandbox-providers/provider-test';
import { SandboxFactory } from '@/lib/sandbox/factory';
import { getProviderConfig, updateProviderConfig } from '@/lib/sandbox/store';
import { applyPreviewUrlCheck, runProviderTest } from '@/lib/sandbox/test-run';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await context.params;
  const row = await getProviderConfig(id);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const provider = SandboxFactory.fromRow(row);
  const result = await runProviderTest({
    driver: row.driver,
    secrets: {},
    providerConfigId: id,
    create: async () => {
      const created = await provider.createSandbox();
      return { sandboxId: created.sandboxId, previewUrl: created.url || provider.getSandboxUrl() };
    },
    runCommand: async () => provider.runCommand('echo navroop-test'),
    kill: async () => {
      await provider.terminate();
    },
  });

  const view = applyPreviewUrlCheck(result, row.driver);

  const message = formatProviderTestResult({
    driver: row.driver,
    ok: view.ok,
    failedAt: view.failedAt,
    error: view.error,
    previewUrl: view.previewUrl,
    leakedSandbox: view.leakedSandbox,
  });
  const fields = fieldsAfterProviderTest({
    ok: view.ok,
    consecutiveFails: row.consecutiveFails,
    lastError: view.ok ? null : message,
    config: row.config,
    now: new Date(),
  });
  await updateProviderConfig(id, fields);

  return NextResponse.json({
    ...view,
    driver: row.driver,
    message,
    healthStatus: fields.healthStatus,
    lastError: fields.lastError,
  });
}
