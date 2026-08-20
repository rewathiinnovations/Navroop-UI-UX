/**
 * Browser side of `/api/onboarding`. The dismissal handlers used to be
 * `void fetch(...)` with no `.then`, no `.catch` and no `response.ok` check, so a
 * failed POST left the panel hidden for one render and back on the next dashboard
 * load, with a rejected promise nobody handled.
 *
 * Kept out of the component so the failure path can be asserted without a DOM.
 */
export type OnboardingAction = 'dismiss-tips' | 'complete-tour';

export type OnboardingSaveResult = { ok: true } | { ok: false; error: string };

const FAILED = 'Could not save that preference — it may come back next time';

export async function saveOnboardingPreference(
  action: OnboardingAction,
): Promise<OnboardingSaveResult> {
  let response: Response;
  try {
    response = await fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  } catch {
    return { ok: false as const, error: FAILED };
  }

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: unknown };
    return { ok: false as const, error: String(data.error || FAILED) };
  }
  return { ok: true as const };
}
