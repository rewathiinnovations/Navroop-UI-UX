import { PrismaClient } from '@/generated/prisma';

// Bump the global key after schema/client changes so Next HMR does not keep a
// PrismaClient constructed against an older generated client (Unknown field stars).
const globalForPrisma = globalThis as unknown as { prismaCheckpoints?: PrismaClient };

export const prisma =
  globalForPrisma.prismaCheckpoints ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prismaCheckpoints = prisma;
}
