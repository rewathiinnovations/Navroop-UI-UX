import { getSetting } from '@/lib/settings/resolve';
import { positiveNumberSetting } from '@/lib/settings/numbers';
import { modelSupportsTools } from './providers';

/**
 * Whether this generation writes files through tools or through parsed fences,
 * and how many tool rounds it may take.
 *
 * Server-only: it reads the settings resolver, which reaches Prisma. Keep it out
 * of anything on the `'use client'` graph — `tests/unit/client-import-boundary.test.ts`
 * is the check, and the tool modules themselves are deliberately pure so they
 * can be unit-tested without one of these reads.
 *
 * Both are resolved per request, never at module load: a value captured at
 * import time is a setting that appears to apply and does not.
 */

/** The default when `ai.maxAgentSteps` is unset or unusable. Matches the registry fallback. */
export const DEFAULT_MAX_AGENT_STEPS = 24;

export async function agentToolsEnabled(model: string): Promise<boolean> {
  const setting = (await getSetting('ai.agentTools'))?.trim();
  if (setting === 'off') return false;
  if (setting === 'on') return true;
  // 'auto', blank, or anything unrecognised: let the measured capability decide.
  // An unprobed model answers false, so a provider change cannot silently ship a
  // generation path that writes no files.
  return modelSupportsTools(model);
}

export async function maxAgentSteps(): Promise<number> {
  return positiveNumberSetting('ai.maxAgentSteps', DEFAULT_MAX_AGENT_STEPS);
}
