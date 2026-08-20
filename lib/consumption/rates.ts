import { log } from '@/lib/logger';
import { getSettings } from '@/lib/settings/resolve';
import type { Rate, RateSource } from './cost';

/**
 * The per-million token rates an operator can confirm on /admin/config.
 *
 * These deliberately have no `fallback` in the registry. A fallback would make
 * `getSetting` always return a number, every estimate would report itself as
 * `operator`-confirmed, and the built-in list price in ./cost would look like a
 * checked figure — which is the exact failure F-029 is about, moved one layer
 * up. Blank means "not confirmed", and the code says so.
 */
export const TOKEN_RATE_SETTING_KEYS = {
  input: 'ai.cost.inputPerMillionUsd',
  output: 'ai.cost.outputPerMillionUsd',
} as const;

/**
 * The rate the operator entered, or null while either knob is blank.
 *
 * Both are required together: half a rate is not a rate, and pricing input from
 * an invoice while output stays on a guess would be harder to notice than
 * either on its own.
 */
export async function loadOperatorTokenRate(): Promise<Rate | null> {
  const values = await getSettings([TOKEN_RATE_SETTING_KEYS.input, TOKEN_RATE_SETTING_KEYS.output]);
  const parsed: Partial<Record<'input' | 'output', number>> = {};
  for (const side of ['input', 'output'] as const) {
    const key = TOKEN_RATE_SETTING_KEYS[side];
    const raw = values[key]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      // Configured but unusable. Silently ignoring it would leave the operator
      // looking at a "Set here" badge while the built-in guess kept billing.
      log.warn('consumption.token_rate_unreadable', { key, raw });
      continue;
    }
    parsed[side] = value;
  }
  if (parsed.input == null || parsed.output == null) return null;
  return { input: parsed.input, output: parsed.output };
}

/** Emitted once per process, so a per-generation warning cannot flood the log. */
let noticedUnconfirmed = false;

/**
 * Says out loud that a cost was priced at something other than a confirmed rate.
 *
 * `unpriced-provider` is logged every time: it means a provider this
 * installation is not supposed to have is being billed at a DeepSeek rate, and
 * that is an anomaly per occurrence, not a standing condition. The standing
 * condition — nobody has confirmed the built-in list price — is worth saying
 * once; the place it has to be visible is /admin/config, not the log.
 */
export function reportRateSource(
  source: RateSource,
  context: { jobId?: string | null; provider?: string | null; model?: string | null },
) {
  if (source === 'operator') return;
  if (source === 'unpriced-provider') {
    log.warn('consumption.unpriced_provider', {
      ...context,
      detail: 'Priced at the DeepSeek fast-tier rate; this provider has no rate of its own.',
    });
    return;
  }
  if (noticedUnconfirmed) return;
  noticedUnconfirmed = true;
  log.warn('consumption.token_rate_unconfirmed', {
    ...context,
    detail: `Costs and the workspace spend ceiling are running on DeepSeek's published list price, which nobody has checked against an invoice. Confirm it on /admin/config → AI providers (${TOKEN_RATE_SETTING_KEYS.input}, ${TOKEN_RATE_SETTING_KEYS.output}).`,
  });
}
