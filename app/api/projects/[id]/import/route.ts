import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { resolveImportMode } from '@/lib/import/mode';
import { runProjectUrlImport } from '@/lib/import/run';
import { normalizeSourceUrl } from '@/lib/import/url';
import { looksLikeUrl } from '@/lib/projects/prompt';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: 'Sign in required' }, { status: 401 });
  }

  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    include: { importSource: true },
  });
  if (!project) {
    return Response.json({ error: 'Project not found' }, { status: 404 });
  }
  if (user.id !== project.ownerId && user.role !== 'ADMIN') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const sourceUrl = normalizeSourceUrl(
    String(body.sourceUrl || project.importSource?.sourceUrl || project.initialPrompt || ''),
  );
  if (!looksLikeUrl(sourceUrl)) {
    return Response.json({ error: 'A source URL is required' }, { status: 400 });
  }
  const mode = resolveImportMode(body.mode ?? project.importSource?.mode);

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const send = async (data: Record<string, unknown>) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  void (async () => {
    try {
      const result = await runProjectUrlImport({
        projectId: project.id,
        userId: user.id,
        sourceUrl,
        mode,
        stack: project.stack,
        designDirection: project.designDirection,
        onProgress: (message) => {
          void send({ type: 'progress', message });
        },
      });
      await send({
        type: 'complete',
        filesXml: result.filesXml,
        warnings: result.warnings,
        usedFallback: result.usedFallback,
        sourceUrl: result.sourceUrl,
        mode: result.mode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed';
      await send({ type: 'error', error: message });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
