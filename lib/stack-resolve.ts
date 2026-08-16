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
}): Promise<{ stack: StackId; designDirection: DesignDirectionId }> {
  if (typeof input.projectId === 'string' && input.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { stack: true, designDirection: true },
    });
    if (!project) {
      throw new Error(`Cannot resolve generation profile: project ${input.projectId} not found`);
    }
    return {
      stack: getStack(project.stack).id,
      designDirection: resolveDirectionId(project.designDirection),
    };
  }
  return {
    stack: await resolveRequestStack({ stack: input.stack }),
    designDirection: input.designDirection
      ? resolveDirectionId(input.designDirection)
      : DEFAULT_DESIGN_DIRECTION,
  };
}
