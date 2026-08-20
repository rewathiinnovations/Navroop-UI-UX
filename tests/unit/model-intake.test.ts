import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_MODELS,
  DEFAULT_DEEPSEEK_MODEL,
  loadProviderChain,
  offeredModel,
  requireUsableProviderChain,
  resolveModel,
  UnknownModelError,
  unknownModelMessage,
} from '@/lib/ai/providers';
import { readGenerationInput } from '@/lib/projects/http';

/**
 * F-003: the `model` field of a generation request used to reach DeepSeek verbatim.
 * `resolveModel` returned the requested string with no membership test, so any
 * authenticated member could pick a model the operator never configured and never
 * priced — and an id that does not exist at all failed at the vendor as
 * `request_rejected` rather than "that model is not available".
 *
 * The fix validates instead of passing through, at the one shared entry point for
 * plan and build. It must not turn into a *default*: an omitted or blank request
 * still has to leave the chain starting at the configured primary
 * (AI_PRIMARY_MODEL / Admin → Configuration), which is the invariant AGENTS.md
 * states and `tests/unit/generate-provider-preflight.test.ts` pins from the route
 * side. Validation and defaulting are opposite things here; only the first is wanted.
 */

const KEYED = { DEEPSEEK_API_KEY: 'sk-test' } as const;

describe('resolveModel validates an explicitly requested model', () => {
  it('refuses a model that is not offered, rather than forwarding it', () => {
    expect(() => resolveModel(KEYED, 'deepseek-reasoner')).toThrow(UnknownModelError);
    // Plain, and it names the id that was refused — the old failure said only
    // `request_rejected`, which reads as an outage rather than a bad choice.
    expect(() => resolveModel(KEYED, 'deepseek-reasoner')).toThrow(/deepseek-reasoner/);
    expect(() => resolveModel(KEYED, 'gpt-4o')).toThrow(UnknownModelError);
  });

  it('carries the refused id and the offered set on the error', () => {
    try {
      resolveModel(KEYED, 'gpt-4o');
      expect.unreachable('an unknown model must not resolve');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelError);
      const refusal = error as UnknownModelError;
      expect(refusal.code).toBe('unknown_model');
      expect(refusal.requestedModel).toBe('gpt-4o');
      expect(refusal.message).toBe(unknownModelMessage('gpt-4o'));
      // The refusal has to tell the caller what it could have sent instead.
      for (const row of DEEPSEEK_MODELS) expect(refusal.message).toContain(row.id);
    }
  });

  it('still lets a valid explicit request outrank the configured primary', () => {
    expect(
      resolveModel({ ...KEYED, AI_PRIMARY_MODEL: 'deepseek-v4-flash' }, 'deepseek-v4-pro'),
    ).toBe('deepseek-v4-pro');
  });

  it('does not inject a default: no request means the configured primary leads', () => {
    expect(resolveModel({ ...KEYED, AI_PRIMARY_MODEL: 'deepseek-v4-pro' })).toBe('deepseek-v4-pro');
    expect(resolveModel({ ...KEYED, AI_PRIMARY_MODEL: 'deepseek-v4-pro' }, '')).toBe(
      'deepseek-v4-pro',
    );
    expect(resolveModel({ ...KEYED, AI_PRIMARY_MODEL: 'deepseek-v4-pro' }, '   ')).toBe(
      'deepseek-v4-pro',
    );
    expect(resolveModel({})).toBe(DEFAULT_DEEPSEEK_MODEL);
  });
});

describe('the provider chain never carries an unoffered model', () => {
  it('propagates the refusal out of loadProviderChain', () => {
    expect(() => loadProviderChain(KEYED, { requestedModel: 'deepseek-reasoner' })).toThrow(
      UnknownModelError,
    );
  });

  it('propagates the refusal out of requireUsableProviderChain', () => {
    expect(() =>
      requireUsableProviderChain(KEYED, { requestedModel: 'deepseek-reasoner' }),
    ).toThrow(UnknownModelError);
  });

  it('builds the entry normally for an offered model', () => {
    const [entry] = requireUsableProviderChain(KEYED, { requestedModel: 'deepseek-v4-pro' });
    expect(entry.model).toBe('deepseek-v4-pro');
  });
});

/**
 * F-004: a stored `Project.model` outranked `ai.primaryModel` for the life of the
 * project, because the workspace seeds its model state from the row and a requested
 * model is pushed to the front of the chain. `readGenerationInput` accepted it as an
 * unvalidated `string | null`, so the row could hold a legacy id from before DeepSeek
 * was the only provider — the single most consequential setting on /admin/config,
 * silently ignored.
 *
 * `offeredModel` is the one place that decides whether a stored value is still a real
 * preference. A value the product no longer offers is not a choice, so it stops being
 * one; an offered value is left alone, because picking Pro on a project whose admin
 * primary is Flash is a legitimate preference, not drift.
 */
describe('offeredModel keeps a stored preference only while it is still offered', () => {
  it('keeps a model that is still in the offered set', () => {
    expect(offeredModel('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(offeredModel('  deepseek-v4-flash  ')).toBe('deepseek-v4-flash');
  });

  it('drops a stale, blank or absent value to undefined', () => {
    expect(offeredModel('deepseek-reasoner')).toBeUndefined();
    expect(offeredModel('gpt-4o')).toBeUndefined();
    expect(offeredModel('')).toBeUndefined();
    expect(offeredModel('   ')).toBeUndefined();
    expect(offeredModel(null)).toBeUndefined();
    expect(offeredModel(undefined)).toBeUndefined();
  });
});

describe('readGenerationInput refuses to store an unoffered model', () => {
  it('stores an offered model as sent', () => {
    expect(readGenerationInput({ model: 'deepseek-v4-pro' }).model).toBe('deepseek-v4-pro');
  });

  it('clears the column instead of persisting a stale or blank id', () => {
    expect(readGenerationInput({ model: 'deepseek-reasoner' }).model).toBeNull();
    expect(readGenerationInput({ model: '' }).model).toBeNull();
    expect(readGenerationInput({ model: null }).model).toBeNull();
    expect(readGenerationInput({ model: 42 }).model).toBeNull();
  });

  it('leaves the column untouched when the field is absent', () => {
    expect(readGenerationInput({}).model).toBeUndefined();
  });
});

const routeSource = readFileSync(
  path.join(
    fileURLToPath(new URL('../../', import.meta.url)),
    'app/api/generate-ai-code-stream/route.ts',
  ),
  'utf8',
);

/**
 * The route-boundary half of F-003, asserted the same way
 * `generate-provider-preflight.test.ts` asserts the release path: the handler is a
 * ~2300-line streaming Next route with a session, a credit check, a project lock, a
 * Job row and a provider slot ahead of the model, so the ordering is what matters and
 * source is the only place it is visible. The refusal has to sit beside the prompt
 * guard — ahead of every acquisition — or a rejected model still costs a lock and a
 * queue slot.
 */
describe('the generate route refuses an unoffered body model at the boundary', () => {
  it('checks the requested model and answers 400 with the plain refusal', () => {
    expect(routeSource).toMatch(/unknownModelMessage\(requestedModel\)/);
    const guardAt = routeSource.indexOf('unknownModelMessage(requestedModel)');
    expect(guardAt).toBeGreaterThan(0);
    expect(routeSource.slice(guardAt, guardAt + 200)).toMatch(/status:\s*400/);
  });

  it('refuses before the session, credits, lock, Job row and provider slot', () => {
    const guardAt = routeSource.indexOf('unknownModelMessage(requestedModel)');
    // Not vacuous: a missing guard would make every `indexOf` below beat -1.
    expect(guardAt).toBeGreaterThan(0);
    for (const acquisition of [
      'await getSessionUser()',
      'await checkCredits(',
      'await holdProjectLock(',
      'await createOrReuseJob(',
      'getDefaultProviderQueue().acquire(',
    ]) {
      expect(routeSource.indexOf(acquisition), acquisition).toBeGreaterThan(guardAt);
    }
  });

  it('keeps the requested model explicit-only', () => {
    // Same invariant as generate-provider-preflight: validation must not become a
    // default that demotes the configured primary.
    expect(routeSource).toMatch(/\{\s*requestedModel\s*\}/);
    expect(routeSource).not.toMatch(/requestedModel\s*=\s*[^;]*appConfig\.ai\.defaultModel/);
  });
});
