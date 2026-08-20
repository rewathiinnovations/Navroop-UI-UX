import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { servedProjectFiles } from '@/lib/checkpoints/served-files';
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
    select: { id: true, stack: true, lastCode: true, contentVersion: true },
  });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  // Any signed-in member may read these. Navroop is a single-workspace product:
  // `listProjects` shows every member every project, the sidebar offers "Shared
  // with me", and the workspace page renders for anyone signed in. An owner-only
  // gate here meant a member could open a teammate's finished project and be told
  // "Nothing to preview yet" — an 85KB site rendered as an empty studio, because
  // the Code tab and the in-browser preview both read this route. Writes stay
  // owner-gated (`canMutate`); reading what the project list already advertises
  // is not the boundary worth defending.

  // A preview is a read: `Project.previewingCheckpointId` decides whether this answers with
  // the live files or that checkpoint's snapshot, and `Project.lastCode` is never rewritten
  // to show an old version (F-102). A preview whose snapshot cannot be read is an error here
  // rather than a quiet fall back to the live files — the pane would otherwise put a
  // "viewing v3" banner over v9's content.
  const served = await servedProjectFiles(project);
  if (!served.ok) {
    return NextResponse.json({ error: served.error }, { status: served.status });
  }
  const files = served.files;
  // `success` and `structure` keep the shape the Code tab already reads, which
  // it used to get from the sandbox file listing.
  return NextResponse.json({
    success: true,
    stack: project.stack,
    contentVersion: project.contentVersion,
    previewing: served.previewing,
    files,
    structure: Object.keys(files).sort().join('\n'),
  });
}
