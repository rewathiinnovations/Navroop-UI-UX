import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveOnboardingPreference } from '@/lib/onboarding/client';

/**
 * F-444: the Dismiss handler in `PromptTipsPanel` was
 * `void fetch('/api/onboarding', …)` with no `.then`, no `.catch` and no
 * `response.ok` check. A failed POST hid the panel for one render, brought it back
 * on the next dashboard load with no explanation, and left a rejected promise
 * unhandled. The write lives here so its failure path is assertable without a DOM.
 */
describe('saveOnboardingPreference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(reply: Response | Error) {
    const calls: Array<[unknown, unknown]> = [];
    vi.stubGlobal('fetch', (input: unknown, init: unknown) => {
      calls.push([input, init]);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    });
    return calls;
  }

  it('posts the action to the onboarding endpoint', async () => {
    const calls = stubFetch(new Response('{}', { status: 200 }));

    expect(await saveOnboardingPreference('dismiss-tips')).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/api/onboarding');
    const init = calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'dismiss-tips' });
  });

  it('reports a rejected status instead of treating it as saved', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401 }));

    expect(await saveOnboardingPreference('dismiss-tips')).toEqual({
      ok: false,
      error: 'Sign in required',
    });
  });

  it('still fails readably when the response carries no error body', async () => {
    stubFetch(new Response('', { status: 500 }));

    const result = await saveOnboardingPreference('complete-tour');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/come back next time/);
  });

  it('swallows no network failure — a thrown fetch is still a failure', async () => {
    stubFetch(new TypeError('Failed to fetch'));

    const result = await saveOnboardingPreference('dismiss-tips');
    expect(result.ok).toBe(false);
  });
});

describe('the prompt tips panel acts on the result of its dismissal', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'components/dashboard/PromptTipsPanel.tsx'),
    'utf8',
  );

  it('awaits the write rather than firing it and forgetting', () => {
    expect(source).not.toMatch(/void fetch\('\/api\/onboarding',\s*\{/);
    expect(source).toContain('await saveOnboardingPreference');
  });

  it('puts the panel back and says so when the write loses', () => {
    expect(source).toContain('setHidden(false)');
    expect(source).toContain('notify.error(result.error)');
  });
});
