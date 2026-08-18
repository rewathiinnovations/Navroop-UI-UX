import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';

/**
 * Consumes a single-use OAuth `state` row, atomically.
 *
 * The row is the only thing making the nonce single-use, and it has a ten-minute TTL. The
 * previous `delete(...).catch(() => undefined)` meant a failed delete left the row alive for
 * the rest of that window, so the same `state` could be replayed — silently.
 *
 * Two things changed. The delete is conditional on the value we read, so exactly one caller
 * can win a concurrent race. And the caller refuses the flow when we did not win: a nonce we
 * cannot prove we consumed is a nonce we must not accept. The cost of refusing is that the
 * operator clicks Connect again; the cost of proceeding is an accepted replay.
 */
export async function consumeRow(key: string, value: string): Promise<boolean> {
  try {
    const consumed = await prisma.appSetting.deleteMany({ where: { key, value } });
    if (consumed.count === 1) return true;
    log.warn('integrations.single_use_state_already_consumed', {
      key,
      message: 'The state row was gone before we could consume it. Refusing to proceed.',
    });
    return false;
  } catch (error) {
    log.error('integrations.single_use_state_not_consumed', {
      key,
      message: 'Could not consume the single-use state row, so it could be replayed. Refusing to proceed.',
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
