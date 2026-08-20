import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { trimConversationState } from '@/lib/generation/conversation-state';

/**
 * The conversation store lives in `lib/generation/conversation-state.ts`, keyed per
 * project (per user for unsaved runs). This route used to hold the whole context in one
 * process-global with no user, workspace or project key: every signed-in member read and
 * wrote the same object, and a `reset` or `clear-old` from anyone destroyed whoever's
 * context happened to be loaded (F-303).
 *
 * The only remaining consumer is the workspace mount's `clear-old`
 * (components/workspace/GenerationWorkspace.tsx), which now names its project and trims
 * only the caller's own key. GET, DELETE, `reset` and `update` had no callers left and
 * are gone with the global.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 'BAD_REQUEST', 400);
  }
  const { action, projectId } = (body ?? {}) as { action?: unknown; projectId?: unknown };
  if (action !== 'clear-old') {
    return jsonError('Invalid action. Use "clear-old"', 'BAD_REQUEST', 400);
  }
  if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
    return jsonError('projectId must be a string', 'BAD_REQUEST', 400);
  }

  if (typeof projectId === 'string' && projectId) {
    // A saved project's conversation is keyed by the project alone, so gate the trim the
    // way every other project mutation is gated: owner or ADMIN.
    const project = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { ownerId: true },
    });
    if (!project) return jsonError('Project not found', 'NOT_FOUND', 404);
    if (auth.user.id !== project.ownerId && auth.user.role !== 'ADMIN') {
      return jsonError('This project belongs to someone else', 'FORBIDDEN', 403);
    }
    trimConversationState(projectId, auth.user.id);
  } else {
    // No saved project yet: the caller's own unsaved-run bucket.
    trimConversationState(null, auth.user.id);
  }

  return NextResponse.json({ success: true, message: 'Old conversation data cleared' });
}
