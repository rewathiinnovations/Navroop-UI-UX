import { prisma } from '@/lib/db';

export type OnboardingPreferences = {
  promptTipsDismissedAt: Date | null;
  productTourCompletedAt: Date | null;
};

export async function getOnboardingPreferences(userId: string): Promise<OnboardingPreferences> {
  const rows = await prisma.$queryRaw<OnboardingPreferences[]>`
    SELECT "promptTipsDismissedAt", "productTourCompletedAt"
    FROM "User"
    WHERE id = ${userId}
  `;
  return {
    promptTipsDismissedAt: rows[0]?.promptTipsDismissedAt ?? null,
    productTourCompletedAt: rows[0]?.productTourCompletedAt ?? null,
  };
}

export async function dismissPromptTips(userId: string) {
  const at = new Date();
  await prisma.$executeRaw`
    UPDATE "User" SET "promptTipsDismissedAt" = ${at} WHERE id = ${userId}
  `;
  return { promptTipsDismissedAt: at };
}

export async function completeProductTour(userId: string) {
  const at = new Date();
  await prisma.$executeRaw`
    UPDATE "User" SET "productTourCompletedAt" = ${at} WHERE id = ${userId}
  `;
  return { productTourCompletedAt: at };
}
