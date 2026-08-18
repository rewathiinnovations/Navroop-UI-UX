import { describe, expect, it } from 'vitest';
import { shouldResumePartial } from '@/lib/jobs/resume';

describe('shouldResumePartial', () => {
  const base = { kind: 'BUILD' as const, attempt: 1, maxAttempts: 2, filesWritten: 2 };

  it('resumes an interrupted build with partial files', () => {
    expect(shouldResumePartial(base)).toBe(true);
  });

  it('never resumes stack_mismatch partials — they are the poison', () => {
    // Live failure: the retry prompt listed the wrong-framework files as
    // "already written and must not be regenerated"; the model refused the
    // task outright instead of rebuilding on the correct layout.
    expect(shouldResumePartial({ ...base, errorCode: 'stack_mismatch' })).toBe(false);
  });

  it('does not resume when no files were written', () => {
    expect(shouldResumePartial({ ...base, filesWritten: 0 })).toBe(false);
  });
});
