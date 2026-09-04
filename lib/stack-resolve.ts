import {
  DEFAULT_DESIGN_DIRECTION,
  resolveDirectionId,
  type DesignDirectionId,
} from '@/lib/design/directions';
import { prisma } from '@/lib/db';
import {
  DEFAULT_STACK,
  getStack,
  isStackId,
  resolveStackOrDefault,
  type StackId,
} from '@/lib/stacks';

/**
 * Resolve the stack stored on a Project.
 * Missing projectId → NEXTJS (legacy generation without a project row).
 * Unknown stored value throws — never coerce another stack to React.
 */
export async function resolveProjectStack(projectId?: string | null): Promise<StackId> {
  if (!projectId) return DEFAULT_STACK;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { stack: true },
  });
  if (!project) {
    throw new Error(`Cannot resolve stack: project ${projectId} not found`);
  }
  return getStack(project.stack).id;
}

/**
 * Request-body resolution for generation and sandbox routes.
 *
 * 1. If `projectId` is present, always load Project.stack from the DB and use it.
 * 2. Else if `stack` is present, use that (validated — unknown ids throw).
 * 3. Else default NEXTJS — only when neither stack nor projectId is provided.
 *
 * Invalid stack strings throw — no silent React fallback.
 */
export async function resolveRequestStack(input: {
  stack?: unknown;
  projectId?: unknown;
}): Promise<StackId> {
  if (typeof input.projectId === 'string' && input.projectId) {
    return resolveProjectStack(input.projectId);
  }
  if (input.stack !== undefined && input.stack !== null && input.stack !== '') {
    if (!isStackId(input.stack)) {
      throw new Error(`Unknown stack "${String(input.stack)}"`);
    }
    return getStack(input.stack).id;
  }
  return resolveStackOrDefault(undefined);
}

export async function resolveRequestGenerationProfile(input: {
  stack?: unknown;
  designDirection?: unknown;
  projectId?: unknown;
}): Promise<{
  stack: StackId;
  designDirection: DesignDirectionId;
  /**
   * The project's own brief, for design selection only.
   *
   * The turn's prompt is not it. On an initial build the prompt is
   * `initialPrompt + "

Approved plan:
" + JSON`, and on an edit it is the
   * edit instruction — both re-score the palette and the style against words
   * the user never wrote about their brand. Planning and building therefore
   * chose from different inputs and could describe two different sites: the
   * plan promised a glassmorphism clinic in stone and gold while the project
   * row said `minimal`. Selecting from this one stable string makes the two
   * calls deterministic in each other.
   */
  initialPrompt: string;
}> {
  if (typeof input.projectId === 'string' && input.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { stack: true, designDirection: true, initialPrompt: true },
    });
    if (!project) {
      throw new Error(`Cannot resolve generation profile: project ${input.projectId} not found`);
    }
    return {
      stack: getStack(project.stack).id,
      designDirection: resolveDirectionId(project.designDirection),
      initialPrompt: project.initialPrompt ?? '',
    };
  }
  return {
    stack: await resolveRequestStack({ stack: input.stack }),
    designDirection: input.designDirection
      ? resolveDirectionId(input.designDirection)
      : DEFAULT_DESIGN_DIRECTION,
    initialPrompt: '',
  };
}
