import { describe, expect, it } from 'vitest';
import { createProviderQueue } from '@/lib/ai/queue';

/**
 * "Concurrent generations" on /admin/config used to do nothing. The queue every
 * build goes through was built once at module load from AI_PROVIDER_CONCURRENCY,
 * so an operator who bought DeepSeek quota and raised the number watched builds
 * keep queueing behind the old limit until the container was redeployed.
 *
 * The limit is now applied per request from the resolved setting, which only
 * helps if raising it also releases whoever is already waiting — otherwise the
 * queued build serves out a limit that no longer exists.
 */

/** The queue's ten-minute wait timeout must not fire during these cases. */
const NEVER = Promise.withResolvers<void>().promise;

describe('provider queue concurrency', () => {
  it('starts a waiting build when the limit is raised', async () => {
    const queue = createProviderQueue({ concurrency: 1, sleep: () => NEVER });
    const first = queue.acquire('deepseek', { jobId: 'job-1' });
    const second = queue.acquire('deepseek', { jobId: 'job-2' });

    expect(first.position).toBe(0);
    expect(second.position).toBe(1);

    queue.setConcurrency(2);

    expect(await second.started).toEqual({ ok: true });
  });

  it('leaves a running build alone when the limit is lowered', async () => {
    const queue = createProviderQueue({ concurrency: 2, sleep: () => NEVER });
    const first = queue.acquire('deepseek', { jobId: 'job-1' });
    queue.setConcurrency(1);

    // Nothing cancels mid-build; the smaller limit only applies to the next slot.
    expect(await first.started).toEqual({ ok: true });
    expect(queue.acquire('deepseek', { jobId: 'job-2' }).position).toBe(1);
  });

  it('keeps the current limit when the value is not a number', () => {
    const queue = createProviderQueue({ concurrency: 2, sleep: () => NEVER });
    queue.setConcurrency(Number.NaN);

    queue.acquire('deepseek', { jobId: 'job-1' });
    expect(queue.acquire('deepseek', { jobId: 'job-2' }).position).toBe(0);
  });

  it('never lets a limit of zero stall the queue', () => {
    const queue = createProviderQueue({ concurrency: 2, sleep: () => NEVER });
    queue.setConcurrency(0);

    // Clamped to one, not to none. `providerConcurrency` already turns a blank
    // or zero admin field into the default, so this is the second line of
    // defence: a queue at zero would never start another build again.
    queue.acquire('deepseek', { jobId: 'job-1' });
    expect(queue.acquire('deepseek', { jobId: 'job-2' }).position).toBe(1);
  });
});
