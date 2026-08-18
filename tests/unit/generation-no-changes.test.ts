import { describe, expect, it } from 'vitest';
import { describeNoChanges } from '../../lib/generation/no-changes';

const FOLLOW_UP_LINE =
  'No changes were made: the AI did not return any files for this request. Please try again, and describe the change in a little more detail — for example, name the page, section or component you want changed.';

describe('describeNoChanges', () => {
  it('keeps the follow-up edit line when the user asked for a change', () => {
    expect(
      describeNoChanges({
        isEdit: true,
        hasProjectFiles: true,
        hasManifest: true,
        providersTried: ['Gemini', 'OpenAI'],
      }),
    ).toBe(FOLLOW_UP_LINE);
  });

  it('names every provider on a first build instead of asking for a more detailed prompt', () => {
    const line = describeNoChanges({
      isEdit: false,
      hasProjectFiles: false,
      hasManifest: false,
      providersTried: ['Gemini', 'OpenAI'],
    });
    expect(line).toBe(
      'The first build finished without any files. Every provider we tried (Gemini, OpenAI) returned no files.',
    );
    expect(line).not.toMatch(/describe the change in a little more detail/);
  });

  it('still names the one provider that was tried when the chain has no fallback', () => {
    expect(
      describeNoChanges({
        isEdit: false,
        hasProjectFiles: false,
        hasManifest: false,
        providersTried: ['Gemini'],
      }),
    ).toBe(
      'The first build finished without any files. Every provider we tried (Gemini) returned no files.',
    );
  });
});
