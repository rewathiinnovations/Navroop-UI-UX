import type { Role } from '@/generated/prisma';
import { prisma } from '@/lib/db';

export type ResultingRoleOrActive = Role | boolean;

/**
 * True when applying `resultingRoleOrActive` would leave zero active admins.
 * Only applies when the target is currently an active ADMIN and the result
 * is MEMBER or inactive.
 */
export async function wouldRemoveLastAdmin(
  targetUserId: string,
  resultingRoleOrActive: ResultingRoleOrActive,
): Promise<boolean> {
  const remainsActiveAdmin =
    resultingRoleOrActive === 'ADMIN' || resultingRoleOrActive === true;
  if (remainsActiveAdmin) return false;

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { role: true, isActive: true },
  });
  if (!target || target.role !== 'ADMIN' || !target.isActive) return false;

  const otherActiveAdmins = await prisma.user.count({
    where: {
      id: { not: targetUserId },
      role: 'ADMIN',
      isActive: true,
    },
  });
  return otherActiveAdmins === 0;
}
