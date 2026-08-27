import { describe, expect, it } from 'vitest';
import { DESIGN_DIRECTION_IDS } from '@/lib/design/directions';
import { OPTIONAL_PREVIEW_DEPS, PREVIEW_DEPS } from '@/lib/preview/deps';
import { STACK_IDS } from '@/lib/stacks';
import { buildStablePromptPrefix } from '@/lib/stack-prompts';

/**
 * The prompt regression net.
 *
 * `buildStablePromptPrefix` is the entire system prompt for every generation,
 * and until this file existed a prompt edit was invisible in review: nothing
 * asserted its content, so a rule could be inverted, dropped, or contradicted
 * by a sibling rule and the only symptom would be worse generated sites weeks
 * later. `PromptVersion` labels a change after the fact; it does not show one.
 *
 * Two properties are asserted, and they are different properties:
 *
 * 1. **Snapshots** — one per stack x direction, so any prompt edit lands as a
 *    reviewable diff. A snapshot failure is not a bug; it is the diff. Read it,
 *    then update it with `-u` if the change is the one you intended.
 * 2. **Cacheability** — the prefix must be byte-identical across calls with the
 *    same arguments and must carry no per-request data. DeepSeek's prefix cache
 *    is automatic and keyed on the literal leading bytes, so one timestamp or
 *    project id in here silently un-caches every request in the deployment.
 */

describe('the stable prompt prefix is stable', () => {
  for (const stack of STACK_IDS) {
    for (const direction of DESIGN_DIRECTION_IDS) {
      it(`${stack} / ${direction} matches its snapshot`, () => {
        expect(buildStablePromptPrefix(stack, direction)).toMatchSnapshot();
      });
    }
  }

  it('is byte-identical across two calls with the same arguments', () => {
    for (const stack of STACK_IDS) {
      for (const direction of DESIGN_DIRECTION_IDS) {
        const first = buildStablePromptPrefix(stack, direction);
        const second = buildStablePromptPrefix(stack, direction);
        expect(second).toBe(first);
      }
    }
  });

  /**
   * The tool path is a second output mode, and it is in the cacheable half — so it
   * has to be byte-stable for the same reason the fence mode is. It must also stay
   * free of the things that are per-project rather than per-configuration: the
   * file list, the user's message, and the *versions* of the optional dependency
   * set. Pinned constants belong in the prefix; a project's chosen dependencies
   * are volatile and belong in the user message.
   */
  it('is byte-identical and volatile-free in tools output mode', () => {
    for (const stack of STACK_IDS) {
      for (const direction of DESIGN_DIRECTION_IDS) {
        const first = buildStablePromptPrefix(stack, direction, { outputMode: 'tools' });
        const second = buildStablePromptPrefix(stack, direction, { outputMode: 'tools' });
        expect(second).toBe(first);
        // The tool contract replaces the fence contract rather than joining it.
        expect(first).toContain('write_file');
        expect(first).not.toContain('{path=');
        // No version strings from either dependency tier.
        for (const version of [
          ...Object.values(PREVIEW_DEPS),
          ...Object.values(OPTIONAL_PREVIEW_DEPS),
        ]) {
          expect(first, `${stack}/${direction} carries the pinned version ${version}`).not.toContain(
            version,
          );
        }
      }
    }
  });

  it('names the optional packages without pinning their versions in the prefix', () => {
    const prefix = buildStablePromptPrefix('NEXTJS', 'minimal', { outputMode: 'tools' });
    // The names are a stable per-configuration constant, so they are cacheable...
    expect(prefix).toContain('zod');
    expect(prefix).toContain('add_dependency');
    // ...while the version the project ends up with is not in here at all.
    expect(prefix).not.toContain(`zod@${OPTIONAL_PREVIEW_DEPS.zod}`);
  });

  it('carries no per-request data', () => {
    // A date, a uuid, or a cuid in the prefix means something request-scoped
    // leaked into the cacheable half.
    const forbidden: Array<[string, RegExp]> = [
      ['a date', /\d{4}-\d{2}-\d{2}/],
      ['a uuid', /[0-9a-f]{8}-[0-9a-f]{4}/i],
      ['a cuid', /cuid|clx[a-z0-9]{20}/i],
    ];
    for (const stack of STACK_IDS) {
      for (const direction of DESIGN_DIRECTION_IDS) {
        const prefix = buildStablePromptPrefix(stack, direction);
        for (const [label, pattern] of forbidden) {
          expect(pattern.test(prefix), `${stack}/${direction} contains ${label}`).toBe(false);
        }
      }
    }
  });

  it('differs per stack and per direction', () => {
    // A prefix that ignored one of its arguments would still pass every check
    // above. 18 distinct prefixes is what proves both arguments are read.
    const prefixes = STACK_IDS.flatMap((stack) =>
      DESIGN_DIRECTION_IDS.map((direction) => buildStablePromptPrefix(stack, direction)),
    );
    expect(new Set(prefixes).size).toBe(STACK_IDS.length * DESIGN_DIRECTION_IDS.length);
  });

  it('the tools output mode replaces the fenced contract and nothing else', () => {
    const fences = buildStablePromptPrefix('NEXTJS', 'premium');
    const tools = buildStablePromptPrefix('NEXTJS', 'premium', { outputMode: 'tools' });

    expect(tools).not.toBe(fences);
    // The fenced protocol is gone, because on this path there is no text format
    // to defend: a file arrives through a validated tool call or not at all.
    expect(tools).not.toMatch(/every fence carries/i);
    expect(tools).toMatch(/goes through write_file/);
    expect(tools).toMatch(/Code reaches the project only through a tool call/);
    // Everything before the contract is untouched, so the cacheable bulk is the
    // same bytes in both modes.
    const upToContract = (text: string) => text.slice(0, text.lastIndexOf('OUTPUT FORMAT:'));
    expect(upToContract(tools)).toBe(upToContract(fences));
  });

  it('the tools prefix is byte-identical across calls and carries nothing volatile', () => {
    // Same DeepSeek prefix-cache invariant as the default mode. The mode is
    // constant for a deployment, so both are cacheable — but only if neither
    // smuggles the project's file list or the user's prompt into the prefix.
    for (const stack of STACK_IDS) {
      for (const direction of DESIGN_DIRECTION_IDS) {
        const first = buildStablePromptPrefix(stack, direction, { outputMode: 'tools' });
        const second = buildStablePromptPrefix(stack, direction, { outputMode: 'tools' });
        expect(second).toBe(first);
        expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(first).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      }
    }
  });
});
