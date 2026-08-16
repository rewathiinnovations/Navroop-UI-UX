import { prisma } from '@/lib/db';
import type { ImportMode } from './mode.ts';
import type { DesignTokens, ImportSection } from './types.ts';

export async function upsertImportSource(input: {
  projectId: string;
  sourceUrl: string;
  mode: ImportMode;
  designTokens?: DesignTokens | Record<string, never>;
  sections?: ImportSection[];
  capturedAt?: Date;
}) {
  const data = {
    sourceUrl: input.sourceUrl,
    mode: input.mode,
    designTokens: (input.designTokens ?? {}) as object,
    sections: (input.sections ?? []) as object,
    capturedAt: input.capturedAt ?? new Date(),
  };
  return prisma.importSource.upsert({
    where: { projectId: input.projectId },
    create: { projectId: input.projectId, ...data },
    update: data,
  });
}
