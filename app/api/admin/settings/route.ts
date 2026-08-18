import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { describeSettings, saveSettings } from '@/lib/settings/resolve';

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  return NextResponse.json(await describeSettings());
}

export async function PUT(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });

  const body = (await request.json().catch(() => ({}))) as {
    values?: Array<{ key?: unknown; value?: unknown }>;
  };
  const inputs = (body.values ?? [])
    .filter((row) => typeof row?.key === 'string' && typeof row?.value === 'string')
    .map((row) => ({ key: row.key as string, value: row.value as string }));

  if (inputs.length === 0) {
    return NextResponse.json({ error: 'No settings to save' }, { status: 400 });
  }

  const result = await saveSettings(inputs, { id: user.id, email: user.email });
  if (result.unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown setting: ${result.unknown.join(', ')}` },
      { status: 400 },
    );
  }

  // Send the fresh view back so the page can show new source badges and masks
  // without a second round trip.
  return NextResponse.json({ saved: result.applied.length, ...(await describeSettings()) });
}
