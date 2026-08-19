import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_PROMPT_KEY,
  clearDraftStorage,
  readDraftStorage,
  templateDraftKey,
  writeDraftStorage,
} from '@/hooks/useDraftStorage';
import { createSignedOutSubmit } from '@/lib/projects/signed-out-submit';

/**
 * A pending prompt is worth real money: `AuthModal.finishAuthenticated` turns one into a
 * project plus a PLAN job. It used to be a single `localStorage` key, `navroop_pending_prompt`,
 * which was also the dashboard hero's autosave — so two things went wrong.
 *
 *   - It was replayed. Any leftover text there was treated as an instruction to create, on
 *     *every* sign-in, `nextPath` ignored, until a creation happened to succeed. The sign-in
 *     at the end of a password reset landed in a brand-new project instead of the page the
 *     user asked for.
 *   - It was clobbered. The template sheet autosaved into the same key on sheet-open (400 ms
 *     after the effect above it filled the box with the template's own brief), so glancing at
 *     a template destroyed the dashboard draft and left that template's id attached to
 *     whatever was sent next — which was then filed as a second use of that template.
 *
 * The handoff is now an in-memory, per-tab, spend-once holder, and every other prompt box has
 * its own storage key.
 */

const SUBMIT = {
  text: 'A landing page for a Pune bakery',
  stack: 'NEXTJS' as const,
  designDirection: 'minimal' as const,
  importMode: 'reimagine' as const,
};

describe('a signed-out submit waiting for sign-in', () => {
  it('is handed over once, so one submit cannot create two projects', () => {
    const submit = createSignedOutSubmit();
    submit.arm(SUBMIT);

    expect(submit.take()).toEqual(SUBMIT);
    // The second sign-in in the same tab — a re-login, a dev quick-login, the sign-in at the
    // end of a password reset — must find nothing left to spend.
    expect(submit.take()).toBeNull();
    expect(submit.take()).toBeNull();
  });

  it('is empty until the visitor actually presses submit', () => {
    // Typing in the hero (which autosaves) is not consent to create anything.
    expect(createSignedOutSubmit().take()).toBeNull();
  });

  it('ignores a blank or whitespace-only submit', () => {
    const submit = createSignedOutSubmit();
    submit.arm({ ...SUBMIT, text: '   \n ' });
    expect(submit.take()).toBeNull();
  });

  it('trims the prompt it hands over', () => {
    const submit = createSignedOutSubmit();
    submit.arm({ ...SUBMIT, text: `  ${SUBMIT.text}  ` });
    expect(submit.take()?.text).toBe(SUBMIT.text);
  });

  it('is withdrawn when the sign-in dialog is closed', () => {
    const submit = createSignedOutSubmit();
    submit.arm(SUBMIT);
    submit.withdraw();
    expect(submit.take()).toBeNull();
  });

  it('is per tab, so a second landing page cannot overwrite the first', () => {
    const firstTab = createSignedOutSubmit();
    const secondTab = createSignedOutSubmit();

    firstTab.arm(SUBMIT);
    secondTab.arm({ ...SUBMIT, text: 'Something else entirely' });

    expect(firstTab.take()?.text).toBe(SUBMIT.text);
    expect(secondTab.take()?.text).toBe('Something else entirely');
  });

  it('carries the stack and design direction the hero was showing', () => {
    const submit = createSignedOutSubmit();
    submit.arm({
      ...SUBMIT,
      stack: 'ASTRO',
      designDirection: 'editorial',
      importMode: 'replicate',
    });

    expect(submit.take()).toEqual({
      text: SUBMIT.text,
      stack: 'ASTRO',
      designDirection: 'editorial',
      importMode: 'replicate',
    });
  });
});

/** A localStorage the draft helpers can actually use; the suite runs without a DOM. */
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('draft keys', () => {
  it('keeps the template sheet out of the hero draft', () => {
    stubLocalStorage();
    writeDraftStorage(PENDING_PROMPT_KEY, 'The brief I am still writing');

    // What the sheet autosaves the moment a template card is opened.
    writeDraftStorage(
      templateDraftKey('tpl_bakery'),
      'Canned bakery brief',
      'NEXTJS',
      'minimal',
      'reimagine',
      'tpl_bakery',
    );

    expect(readDraftStorage(PENDING_PROMPT_KEY)?.text).toBe('The brief I am still writing');
    // And no template id leaks into the hero draft, so the next dashboard submit is not
    // filed as another use of a template it has nothing to do with.
    expect(readDraftStorage(PENDING_PROMPT_KEY)?.templateId).toBeNull();
  });

  it('gives every template its own draft', () => {
    stubLocalStorage();
    writeDraftStorage(templateDraftKey('tpl_a'), 'Draft for A');
    writeDraftStorage(templateDraftKey('tpl_b'), 'Draft for B');

    expect(readDraftStorage(templateDraftKey('tpl_a'))?.text).toBe('Draft for A');
    expect(readDraftStorage(templateDraftKey('tpl_b'))?.text).toBe('Draft for B');
    expect(templateDraftKey('tpl_a')).not.toBe(PENDING_PROMPT_KEY);
  });

  it('forgets a template draft once it has become a project', () => {
    stubLocalStorage();
    writeDraftStorage(templateDraftKey('tpl_a'), 'Edited brief');

    clearDraftStorage(templateDraftKey('tpl_a'));

    // Reopening the card shows the template's own brief again, not the copy already spent.
    expect(readDraftStorage(templateDraftKey('tpl_a'))).toBeNull();
  });
});

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function source(relative: string) {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

/**
 * These two are source claims on purpose, and they are narrow ones: the bug was not a wrong
 * value, it was one module reading or writing a key that belongs to another. Rendering
 * `AuthModal` would need a DOM and a session provider the unit suite does not have.
 */
describe('who is allowed to touch the hero draft key', () => {
  it('does not let AuthModal decide to create a project from stored text', () => {
    const modal = source('components/app/auth/AuthModal.tsx');

    expect(modal).not.toContain('readDraftStorage');
    // The submit arrives as a prop and is taken, not read out of shared storage.
    expect(modal).toContain('takePendingPrompt');
  });

  it('does not let the template sheet write the hero draft key', () => {
    const sheet = source('components/templates/TemplateSheet.tsx');

    expect(sheet).toContain('templateDraftKey');
    expect(sheet).not.toContain('PENDING_PROMPT_KEY');
  });
});
