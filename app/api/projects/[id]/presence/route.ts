import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getPresenceSnapshot, heartbeatPresence } from '@/lib/projects/presence';

async function loadProject(id: string) {
  return prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
}

async function snapshotResponse(projectId: string, user: { id: string; role: string }) {
  const data = await getPresenceSnapshot(projectId);
  return NextResponse.json({
    viewers: data.viewers.map((row) => ({
      id: row.id,
      name: row.name,
      avatarUrl: row.avatarUrl,
      lastSeenAt: row.lastSeenAt.toISOString(),
    })),
    lock: {
      locked: data.lock.locked,
      heldBy: data.lock.heldBy,
      expiresAt: data.lock.expiresAt ? data.lock.expiresAt.toISOString() : null,
      reason: data.lock.reason,
    },
    contentVersion: data.contentVersion,
    viewerId: user.id,
    viewerRole: user.role,
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  const { id } = await params;
  const project = await loadProject(id);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  return snapshotResponse(id, user);
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  const { id } = await params;
  const project = await loadProject(id);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  await heartbeatPresence(id, user.id);
  return snapshotResponse(id, user);
}
