import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';
import {
  installPackages,
  precheckInstall,
  type InstallProgressEvent,
} from '@/lib/sandbox/install-packages';

export async function POST(request: NextRequest) {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  let packages: unknown;
  try {
    ({ packages } = await request.json());
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  // Decide the non-streaming answers before committing to a stream.
  const precheck = precheckInstall(packages);
  if (precheck.kind === 'error') {
    return NextResponse.json({ success: false, error: precheck.error }, { status: precheck.status });
  }
  if (precheck.kind === 'skipped') {
    return NextResponse.json({ success: true, skipped: true, message: precheck.message });
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const onProgress = async (event: InstallProgressEvent) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  void installPackages({ packages, onProgress })
    .catch(async (error: unknown) => {
      console.error('[install-packages] Unhandled failure:', error);
      await onProgress({
        type: 'error',
        message: error instanceof Error ? error.message : 'Package installation failed',
      });
    })
    .finally(() => writer.close());

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
