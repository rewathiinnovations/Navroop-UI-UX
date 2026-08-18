import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { SETTING_GROUPS, type SettingGroupId } from '@/lib/settings/registry';
import { testSettingGroup } from '@/lib/settings/test-group';

const VALID = new Set<string>(SETTING_GROUPS.map((group) => group.id));

export async function POST(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });

  const body = (await request.json().catch(() => ({}))) as { group?: unknown };
  const group = typeof body.group === 'string' ? body.group : '';
  if (!VALID.has(group)) {
    return NextResponse.json({ error: 'Unknown settings group' }, { status: 400 });
  }

  return NextResponse.json(await testSettingGroup(group as SettingGroupId));
}
