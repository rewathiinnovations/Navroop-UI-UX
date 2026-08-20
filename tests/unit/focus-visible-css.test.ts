import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * F-400. The last rule in `styles/main.css` was
 *
 *   input[type="text"]:focus, input[type="text"]:focus-visible {
 *     outline: none !important; box-shadow: none !important; border-color: inherit !important;
 *   }
 *
 * commented "Remove all focus styles from hero input" — but the selector names no
 * hero. Tailwind compiles `focus-visible:ring-2` to a `box-shadow`, so
 * `box-shadow: none !important` beat the ring on every studio field, and
 * `border-color: inherit !important` took the border fallback with it. Tabbing
 * through `/admin/config` — where a non-secret, non-numeric setting renders as
 * `type="text"` — showed no focus at all (WCAG 2.4.7).
 *
 * A stylesheet cannot be rendered here, so this reads it: no global rule may
 * suppress a text input's focus indicator, and the two fields the finding names
 * as victims must keep the ring the rule was beating. Nothing replaced the rule
 * for the hero, because that hero — components/app/(home)/sections/hero-input/ —
 * has no route rendering it.
 */
function repoFile(relative: string) {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
}

/** Declarations only: a comment explaining the deleted rule is not the rule. */
const css = repoFile('styles/main.css').replace(/\/\*[\s\S]*?\*\//g, '');
const configAdmin = repoFile('app/(app)/admin/config/ConfigAdmin.tsx');
const studioField = repoFile('components/app/studio/StudioField.tsx');

describe('the global stylesheet does not delete focus rings', () => {
  it('suppresses no focus indicator with !important', () => {
    expect(css).not.toMatch(/outline:\s*none\s*!important/);
    // A Tailwind ring *is* a box-shadow. `!important` on it is unbeatable from a
    // component, which is why every studio field lost its ring at once.
    expect(css).not.toMatch(/box-shadow:\s*none\s*!important/);
    expect(css).not.toMatch(/border-color:\s*inherit\s*!important/);
  });

  it('leaves no unscoped rule targeting every text input on the page', () => {
    // Anchored on the attribute selector, so @layer nesting cannot confuse it.
    const selectors = [...css.matchAll(/([^{}]*input\[type=["']text["'][^{}]*)\{[^{}]*\}/g)].map(
      (match) => match[1].trim(),
    );
    const unscoped = selectors.filter(
      (selector) => !selector.includes('.') && !selector.includes('#'),
    );
    expect(unscoped).toEqual([]);
  });
});

describe('the fields the rule was breaking still carry a ring', () => {
  it('keeps it on the admin setting field', () => {
    // ConfigAdmin renders a non-secret, non-numeric setting as type="text", which
    // is exactly what the deleted selector matched.
    expect(configAdmin).toMatch(/focus-visible:ring-2/);
  });

  it('keeps it on the studio field behind the invite dialog', () => {
    // "Name (optional)" in the admin invite dialog is a StudioField type="text".
    expect(studioField).toMatch(/focus-visible:ring-2/);
  });
});
