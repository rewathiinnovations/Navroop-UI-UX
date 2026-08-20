/**
 * F-823: `adminGenerateThumbnails` looped over *every* built-in template without
 * a thumbnail and, for each one, created a real project (a full plan flow, an AI
 * call), published a real Coolify preview, captured a screenshot and soft-deleted
 * the project — all sequential, all inside one server action that returned
 * nothing until the last iteration finished. With the ten seeded built-ins that
 * is ten AI plans plus ten deploys in one request: far past any gateway or
 * server-action timeout, so the operator saw a failure while the work carried on
 * and the results array was lost. Each iteration also spent credits and a
 * publish slot, and the plan limit was checked once, for a single project.
 *
 * The batch is therefore bounded to one template per press. The operator gets a
 * result they can read, `remaining` tells them how much is left, and stopping is
 * simply not pressing again — which is the only cancellation that can work for a
 * synchronous action. Lives outside the `'use server'` module so the bound is a
 * plain unit test rather than an integration one.
 */

export const TEMPLATE_THUMBNAIL_BATCH_LIMIT = 1;

export type ThumbnailCandidate = {
  isBuiltIn: boolean;
  thumbnailKey: string | null;
};

export function selectThumbnailTargets<T extends ThumbnailCandidate>(
  rows: T[],
  limit: number = TEMPLATE_THUMBNAIL_BATCH_LIMIT,
): { targets: T[]; remaining: number } {
  const pending = rows.filter((row) => row.isBuiltIn && !row.thumbnailKey);
  // A caller cannot opt out of the bound: 0 or a negative limit would make the
  // action a no-op that reported success, which is the failure mode this whole
  // wave is about.
  const bounded = Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 1));
  const targets = pending.slice(0, bounded);
  return { targets, remaining: pending.length - targets.length };
}

export function thumbnailBatchMessage(input: { generated: number; remaining: number }): string {
  if (input.remaining > 0) {
    return `Generated ${input.generated}. ${input.remaining} built-in template${
      input.remaining === 1 ? '' : 's'
    } still need a thumbnail — press Generate thumbnails again to continue. Each one creates a real project and a real preview deploy, so they run one at a time.`;
  }
  return `Generated ${input.generated}. Every built-in template now has a thumbnail.`;
}
