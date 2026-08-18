export const SSRF_PRIVATE_REJECTS_KEY = 'ssrf.privateRejects';

export type SsrfRejectCounts = {
  total: number;
  byUser: Record<string, number>;
};

export type RejectLogInput = {
  code: string;
  userId?: string;
  raw?: string;
};

function hostFromRaw(raw?: string) {
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return '';
  }
}

/**
 * Telemetry for a request that is already being refused, so it never throws and never
 * changes the outcome — but callers may safely `await` it, and they should: the
 * private-range counter on `/admin/usage` is how an operator sees an active SSRF probe, and
 * a write that is discarded mid-flight reads as no activity at all.
 */
export async function logRejectedUrl(input: RejectLogInput) {
  const host = hostFromRaw(input.raw);
  console.warn('[url-guard] rejected', {
    reason: input.code,
    userId: input.userId || null,
    host,
  });
  if (input.code !== 'private' || !input.userId) return { counted: false as const };
  try {
    await incrementPrivateReject(input.userId);
    return { counted: true as const };
  } catch (error) {
    console.warn('[url-guard] failed to record private reject', {
      message: 'An SSRF probe will under-report on /admin/usage.',
      error: error instanceof Error ? error.message : String(error),
    });
    return { counted: false as const };
  }
}

/**
 * Fire-and-forget form for synchronous call sites that cannot await. Still logged — the
 * point is to never leave an unhandled rejection behind.
 */
export function recordRejectedUrl(input: RejectLogInput) {
  void logRejectedUrl(input).catch((error) => {
    console.warn('[url-guard] failed to log a rejected URL', error);
  });
}

function parseCounts(value: string | null | undefined): SsrfRejectCounts {
  if (!value) return { total: 0, byUser: {} };
  try {
    const parsed = JSON.parse(value) as SsrfRejectCounts;
    return {
      total: typeof parsed.total === 'number' ? parsed.total : 0,
      byUser: parsed.byUser && typeof parsed.byUser === 'object' ? parsed.byUser : {},
    };
  } catch {
    return { total: 0, byUser: {} };
  }
}

export async function incrementPrivateReject(userId: string) {
  const { prisma } = await import('../db');
  // The counter is a JSON blob, so read-modify-write is the only shape available.
  // A transaction-scoped advisory lock serialises concurrent rejects instead of
  // letting them overwrite each other's totals.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SSRF_PRIVATE_REJECTS_KEY}))`;
    const row = await tx.appSetting.findUnique({
      where: { key: SSRF_PRIVATE_REJECTS_KEY },
      select: { value: true },
    });
    const counts = parseCounts(row?.value);
    counts.total += 1;
    counts.byUser[userId] = (counts.byUser[userId] || 0) + 1;
    const value = JSON.stringify(counts);
    await tx.appSetting.upsert({
      where: { key: SSRF_PRIVATE_REJECTS_KEY },
      create: { key: SSRF_PRIVATE_REJECTS_KEY, value },
      update: { value },
    });
    return counts;
  });
}

export async function getSsrfPrivateRejectCounts(): Promise<SsrfRejectCounts> {
  try {
    const { prisma } = await import('../db');
    const row = await prisma.appSetting.findUnique({
      where: { key: SSRF_PRIVATE_REJECTS_KEY },
      select: { value: true },
    });
    return parseCounts(row?.value);
  } catch (error) {
    console.warn('[url-guard] failed to read private reject counts', error);
    return { total: 0, byUser: {} };
  }
}
