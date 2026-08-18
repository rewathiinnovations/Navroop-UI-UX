import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { forceRelease } from '@/lib/projects/lock';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  if (user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  const result = await forceRelease(id, user.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 403 });
  const { writeAudit } = await import('@/lib/audit/log');
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'lock.force_release',
    targetType: 'project',
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}
