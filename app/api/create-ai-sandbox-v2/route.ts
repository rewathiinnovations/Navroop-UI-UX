import { NextRequest, NextResponse } from 'next/server';
import { bootEphemeralSandbox, ensureSandbox, SandboxBootError } from '@/lib/sandbox/manager';
import { resolveRequestStack } from '@/lib/stack-resolve';
import { getStack } from '@/lib/stacks';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  try {
    const body = (await request.json().catch(() => ({}))) as {
      stack?: unknown;
      projectId?: unknown;
    };
    const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null;

    if (projectId) {
      const result = await ensureSandbox(projectId, { allowEmpty: true });
      return NextResponse.json({
        success: true,
        sandboxId: result.sandboxId,
        url: result.previewUrl,
        wasColdStarted: result.wasColdStarted,
        requestId: result.requestId,
        message: result.wasColdStarted ? 'Sandbox restored from latest checkpoint' : 'Sandbox already running',
      });
    }

    const stack = await resolveRequestStack({
      stack: body.stack,
      projectId: body.projectId,
    });
    const stackDef = getStack(stack);
    const created = await bootEphemeralSandbox(stackDef.id);

    return NextResponse.json({
      success: true,
      sandboxId: created.sandboxId,
      url: created.previewUrl,
      provider: created.provider,
      stack: created.stack,
      message: `Sandbox created and ${stackDef.label} app initialized`,
    });
  } catch (error) {
    console.error('[create-ai-sandbox-v2] Error:', error);
    const boot = error instanceof SandboxBootError ? error : null;
    if (boot?.code === 'SANDBOX_LIMIT') {
      return NextResponse.json(
        { reason: 'sandboxes', used: 0, limit: 0, message: boot.message },
        { status: 402 },
      );
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to create sandbox',
        step: boot?.step,
        code: boot?.code,
        requestId: boot?.requestId,
      },
      { status: boot?.code === 'NO_CHECKPOINT' ? 409 : 500 },
    );
  }
}
