import { describe, expect, it } from 'vitest';
import { shouldRequestSandbox } from '../../lib/workspace/sandbox-request';

describe('when the workspace asks for a sandbox', () => {
  it('does not boot a sandbox just because a project was opened', () => {
    expect(shouldRequestSandbox('open')).toBe(false);
  });

  it('still boots when the user generates, turns on Live mode, or restores', () => {
    expect(shouldRequestSandbox('generate')).toBe(true);
    expect(shouldRequestSandbox('live')).toBe(true);
    expect(shouldRequestSandbox('restore')).toBe(true);
  });
});
