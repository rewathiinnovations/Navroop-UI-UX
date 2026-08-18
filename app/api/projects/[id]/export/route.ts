import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { withRequest } from '@/lib/api/with-request';
import { log } from '@/lib/logger';
import {
  allowExport,
  buildExportFilename,
  buildExportReadme,
  collectExportFiles,
  streamExportZip,
} from '@/lib/export';
import { assertFreeSpaceForLargeOp } from '@/lib/runtime/data-dir';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequest(request, () => exportProject(request, params));
}

async function exportProject(request: NextRequest, params: Promise<{ id: string }>) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const rate = allowExport(user.id);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Export limit reached — try again in an hour' },
      { status: 429 },
    );
  }

  try {
    assertFreeSpaceForLargeOp();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Not enough free space to export';
    return NextResponse.json({ error: message }, { status: 507 });
  }

  const { id } = await params;
  const checkpointId = request.nextUrl.searchParams.get('checkpointId');

  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      stack: true,
      sandboxStatus: true,
      checkpoints: {
        where: { snapshotPruned: false },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          snapshotKey: true,
          fileSnapshot: true,
          createdAt: true,
        },
      },
    },
  });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  if (checkpointId && !project.checkpoints.some((row) => row.id === checkpointId)) {
    return NextResponse.json({ error: 'Checkpoint not found' }, { status: 404 });
  }

  const files = await collectExportFiles({
    projectId: project.id,
    checkpointId,
    sandboxStatus: project.sandboxStatus,
    checkpoints: project.checkpoints,
  });
  if (files.length === 0) {
    return NextResponse.json({ error: 'No checkpoint files to export' }, { status: 409 });
  }

  // Export a runnable repository, not just the generated components: the
  // stack scaffold and Dockerfile ride along so the download builds and
  // deploys without the user assembling a project around it.
  const { buildRepoFiles } = await import('@/lib/deploy/repo-files');
  const repoFiles = buildRepoFiles(
    project.stack,
    Object.fromEntries(files.map((file) => [file.path, file.content])),
    { projectName: project.name },
  );
  const exportFiles = Object.entries(repoFiles).map(([path, content]) => ({ path, content }));

  const readme = buildExportReadme({ name: project.name, stack: project.stack });
  const { withRecordedJob } = await import('@/lib/jobs/wrap');
  await withRecordedJob(
    {
      projectId: project.id,
      userId: user.id,
      kind: 'EXPORT',
      inputPrompt: checkpointId || project.checkpoints[0]?.id || 'latest',
    },
    async () => undefined,
  );
  // Exports do not consume credits. Downloading a checkpoint is not generation.
  // Recorded as a short Job for the admin trail; ZIP streaming has no status to strand.
  log.info('project.export', {
    userId: user.id,
    projectId: project.id,
    checkpointId: checkpointId || project.checkpoints[0]?.id || null,
  });

  const body = await streamExportZip(exportFiles, readme);
  const filename = buildExportFilename(project.name);
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
