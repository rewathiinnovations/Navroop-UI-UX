import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { recordThumbs } from '@/lib/signals/collect';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const rating = body.rating === 'up' || body.rating === 'down' ? body.rating : null;
  if (body.kind !== 'thumbs' || !rating) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }

  const signal = await recordThumbs(id, rating);
  return NextResponse.json({ ok: true, signal });
}
