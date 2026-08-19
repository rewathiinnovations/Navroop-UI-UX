import type { DesignDirectionId } from '@/lib/design/directions';
import type { ImportMode } from '@/lib/import/mode';
import type { StackId } from '@/lib/stacks';

/** A hero submit that could not run yet because nobody was signed in. */
export type PendingPrompt = {
  text: string;
  stack: StackId;
  designDirection: DesignDirectionId;
  importMode: ImportMode;
};

export type SignedOutSubmit = {
  /** Pressing submit while signed out. Blank text arms nothing. */
  arm: (prompt: PendingPrompt) => void;
  /** Hands the submit over and forgets it. At most one project per submit. */
  take: () => PendingPrompt | null;
  /** Closing the sign-in dialog: the submit is off. */
  withdraw: () => void;
};

/**
 * The landing page's "create this once you are signed in" handoff.
 *
 * It lives in memory, per tab, and empties itself on `take`, because the previous version
 * lived in `localStorage` under `navroop_pending_prompt` — the hero's own autosave key — and
 * `AuthModal` treated any text sitting there as an instruction to create a project. Two
 * things followed. A second tab, or the template sheet, overwrote the submit with something
 * else. And an abandoned half-written draft turned the *next* sign-in into a brand-new
 * project with a plan job running against it, `nextPath` ignored, retried on every sign-in
 * until one succeeded — including the sign-in at the end of a password reset, where the
 * visitor was trying to get back into an account, not spend credits.
 *
 * Consent is the submit press, not the presence of text, and it is spent when it is taken.
 */
export function createSignedOutSubmit(): SignedOutSubmit {
  let pending: PendingPrompt | null = null;
  return {
    arm(prompt) {
      const text = prompt.text.trim();
      pending = text ? { ...prompt, text } : null;
    },
    take() {
      const armed = pending;
      pending = null;
      return armed;
    },
    withdraw() {
      pending = null;
    },
  };
}
