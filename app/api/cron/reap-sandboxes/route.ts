import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { createCheckpoint } from '@/lib/checkpoints/actions';
import { idleMinutes, killSandbox } from '@/lib/sandbox/manager';

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!secret || token !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - idleMinutes() * 60_000);
  const idle = await prisma.project.findMany({
    where: {
      deletedAt: null,
      sandboxStatus: 'READY',
      sandboxLastUsedAt: { lt: cutoff },
    },
    select: { id: true, previewUrl: true },
  });

  let reaped = 0;
  for (const project of idle) {
    const checkpointCount = await prisma.checkpoint.count({ where: { projectId: project.id } });
    if (checkpointCount === 0) {
      try {
        await createCheckpoint(project.id, {
          trigger: 'followup',
          sourceMessage: 'Idle sandbox reap',
          previewUrl: project.previewUrl,
        });
      } catch (error) {
        console.warn('[reap-sandboxes] checkpoint before reap failed', project.id, error);
      }
    }
    try {
      await killSandbox(project.id);
      reaped += 1;
    } catch (error) {
      console.warn('[reap-sandboxes] kill failed', project.id, error);
    }
  }

  console.log(`[reap-sandboxes] reaped ${reaped} idle sandbox(es) (candidates=${idle.length})`);
  return NextResponse.json({ ok: true, reaped, candidates: idle.length });
}
