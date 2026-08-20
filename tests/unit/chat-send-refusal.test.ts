import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SidebarInput from '@/components/app/generation/SidebarInput';
import { looksLikeUrl } from '@/lib/projects/prompt';
import {
  SEND_REFUSED_ALREADY_RUNNING,
  sendOutcomeForStream,
  shouldRestoreRefusedText,
} from '@/components/workspace/types';
import type { GenerateResult } from '@/lib/generation/types';

/**
 * F-002. `createOrReuseJob` hands back the project's existing active job and the
 * route answers `{ job, reused: true }` as JSON rather than SSE, which
 * `runGenerateStream` turns into `{ generatedCode: '', alreadyRunning: true }`.
 * `sendChatMessage` had already appended the bubble and cleared the box, and its
 * `if (generatedCode)` guard is false — so nothing was said, and the status line
 * then read "Generation complete!". The prompt was gone from the input, the draft,
 * and the job row (`inputPrompt` is written on insert only).
 *
 * The decision is what is tested here: a reused job is a *refused* send, and a
 * refused send puts the text back.
 */
describe('a send the server refused is not reported as a build', () => {
  it('reads a reused job as refused, not accepted', () => {
    const outcome = sendOutcomeForStream({ alreadyRunning: true });
    expect(outcome.accepted).toBe(false);
    expect(outcome).toEqual({ accepted: false, reason: 'already-running' });
  });

  it('reads a normal stream as accepted', () => {
    expect(sendOutcomeForStream({}).accepted).toBe(true);
    expect(sendOutcomeForStream({ alreadyRunning: false }).accepted).toBe(true);
  });

  it('says a build was already running and that nothing was sent', () => {
    expect(SEND_REFUSED_ALREADY_RUNNING).toMatch(/already running/i);
    expect(SEND_REFUSED_ALREADY_RUNNING).toMatch(/not sent/i);
    // The line this replaces claimed the opposite.
    expect(SEND_REFUSED_ALREADY_RUNNING).not.toMatch(/complete/i);
  });
});

describe('a refused send hands the typed text back', () => {
  it('restores it when the box is still empty', () => {
    expect(shouldRestoreRefusedText({ accepted: false, reason: 'already-running' }, '')).toBe(true);
    expect(shouldRestoreRefusedText({ accepted: false, reason: 'already-running' }, '   ')).toBe(
      true,
    );
  });

  it('leaves a newer draft alone rather than overwriting it', () => {
    // Refusals land asynchronously. Pasting the old prompt over what the person
    // has started typing since would lose more text than the refusal did.
    expect(
      shouldRestoreRefusedText({ accepted: false, reason: 'already-running' }, 'add a footer'),
    ).toBe(false);
  });

  it('restores nothing for an accepted send or a caller that cannot refuse', () => {
    expect(shouldRestoreRefusedText({ accepted: true }, '')).toBe(false);
    expect(shouldRestoreRefusedText(undefined, '')).toBe(false);
  });

  it('carries the runtime\u2019s own reused return through to a restore', () => {
    // The literal shape `runGenerateStream` resolves on the `{ reused: true }`
    // branch, so this fails if that return ever drops `alreadyRunning` again.
    const reused: GenerateResult = {
      generatedCode: '',
      explanation: '',
      packagesToInstall: [],
      skillNames: [],
      alreadyRunning: true,
    };
    const outcome = sendOutcomeForStream(reused);
    // The box is empty by then: ChatInput cleared it on submit and holds the text
    // in a local, which is what it puts back.
    expect(shouldRestoreRefusedText(outcome, '')).toBe(true);

    const streamed: GenerateResult = { ...reused, generatedCode: '<file path="a.tsx"/>' };
    expect(
      shouldRestoreRefusedText(sendOutcomeForStream({ ...streamed, alreadyRunning: false }), ''),
    ).toBe(false);
  });
});

/**
 * F-405. `SidebarInput` held `const [isValidUrl, setIsValidUrl] = useState(false)`
 * whose only writer was `setIsValidUrl(false)`, and the whole options block —
 * style picker, model select, instructions, **Scrape Site** — sat behind
 * `{isValidUrl && …}`. The URL field the flag referred to had been deleted, and
 * the validator was left commented out above it. The component rendered one
 * button, "Back to projects", so `onSubmit` (five pieces of workspace state and a
 * paid generation) could never fire.
 *
 * No DOM library is installed, so this is a static render: the field must be on
 * screen to type into, and the options must be hidden until the URL is one.
 */
describe('SidebarInput exposes the scrape panel', () => {
  const markup = renderToStaticMarkup(
    createElement(SidebarInput, { onSubmit: () => {}, disabled: false }),
  );

  it('renders a URL field, not just "Back to projects"', () => {
    expect(markup).toContain('Back to projects');
    expect(markup).toContain('Site to clone');
    // Not `type="url"`: a bare domain is accepted here, which native validation
    // would reject. The URL keyboard comes from inputmode instead.
    expect(markup).toMatch(/<input[^>]+inputmode="url"/i);
    expect(markup).toContain('https://example.com');
  });

  it('keeps the options hidden until there is a URL', () => {
    expect(markup).not.toContain('Scrape Site');
    expect(markup).not.toContain('Glassmorphism');
  });

  it('decides validity with the predicate the rest of the product uses', () => {
    expect(looksLikeUrl('https://stripe.com/pricing')).toBe(true);
    expect(looksLikeUrl('example.com')).toBe(true);
    expect(looksLikeUrl('')).toBe(false);
    expect(looksLikeUrl('build me a bakery site')).toBe(false);
    expect(looksLikeUrl('https://')).toBe(false);
  });
});
