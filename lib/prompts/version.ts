import { createHash } from 'crypto';
import { prisma } from '@/lib/db';
import { DESIGN_DIRECTION_IDS } from '@/lib/design/directions';
import { MEMORY_CATEGORIES, MEMORY_TOKEN_BUDGET } from '@/lib/memory/types';
import { STACK_IDS } from '@/lib/stacks';
import { buildStablePromptPrefix } from '@/lib/stack-prompts';

export const BASELINE_PROMPT_LABEL = 'v1 baseline';

/**
 * Hash input: every assembled stable prefix (base-rules + seo + direction + stack,
 * including image rules already in the prefix, and memory if the assembler adds it).
 */
export function assembleVersionedPrefix(): string {
  const prefixes = STACK_IDS.flatMap((stack) =>
    DESIGN_DIRECTION_IDS.map((direction) => buildStablePromptPrefix(stack, direction)),
  );
  const memorySlot = `MEMORY_SLOT categories=${MEMORY_CATEGORIES.join(',')} budget=${MEMORY_TOKEN_BUDGET}`;
  return [...prefixes, memorySlot].join('\n\n---\n\n');
}

export function hashPromptPrefix(prefix: string): string {
  return createHash('sha256').update(prefix, 'utf8').digest('hex');
}

export function currentPromptHash() {
  return hashPromptPrefix(assembleVersionedPrefix());
}

export async function getActivePromptVersion() {
  const existing = await prisma.promptVersion.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;

  const hash = currentPromptHash();
  const already = await prisma.promptVersion.findUnique({ where: { hash } });
  if (already) {
    if (!already.isActive) {
      await prisma.promptVersion.updateMany({ data: { isActive: false } });
      return prisma.promptVersion.update({
        where: { id: already.id },
        data: { isActive: true },
      });
    }
    return already;
  }

  return prisma.promptVersion.create({
    data: {
      hash,
      label: BASELINE_PROMPT_LABEL,
      config: {
        stacks: [...STACK_IDS],
        directions: [...DESIGN_DIRECTION_IDS],
        memorySlot: { categories: [...MEMORY_CATEGORIES], tokenBudget: MEMORY_TOKEN_BUDGET },
        seed: BASELINE_PROMPT_LABEL,
      },
      isActive: true,
    },
  });
}

export async function stampActivePromptHash() {
  const version = await getActivePromptVersion();
  return version.hash;
}
