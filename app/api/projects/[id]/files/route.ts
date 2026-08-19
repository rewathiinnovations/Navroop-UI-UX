import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { withRequest } from '@/lib/api/with-request';

/**
 * A project's current files.
 *
 * The Code tab and the preview both used to read these out of a sandbox over
 * /api/get-sandbox-files. The files live in the database now, so this is the
 * one place that serves them.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequest(request, () => getFiles(params));
}

async function getFiles(params: Promise<{ id: string }>) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, ownerId: true, stack: true, lastCode: true, contentVersion: true },
  });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  if (project.ownerId !== user.id && user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const files = getCurrentProjectFiles({ lastCode: project.lastCode });
  // `success` and `structure` keep the shape the Code tab already reads, which
  // it used to get from the sandbox file listing.
  return NextResponse.json({
    success: true,
    stack: project.stack,
    contentVersion: project.contentVersion,
    files,
    structure: Object.keys(files).sort().join('\n'),
  });
}
