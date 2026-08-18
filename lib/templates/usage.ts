import { prisma } from '@/lib/db';

/** Atomic increment: UPDATE ... SET usageCount = usageCount + 1 */
export async function incrementUsageCount(templateId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ usageCount: number }>>`
    UPDATE "Template"
    SET "usageCount" = "usageCount" + 1
    WHERE id = ${templateId}
    RETURNING "usageCount"
  `;
  return Number(rows[0]?.usageCount ?? 0);
}
