import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROVIDER_CONFIGURED_MESSAGE } from '../../lib/ai/providers';
import { jobAdminFailureLine } from '../../lib/jobs/admin-display';
import { recoveryCauseLine, recoveryNextStepLine } from '../../lib/jobs/copy';

const GEMINI_KEY_REJECTED =
  'Gemini rejected the API key. Ask an administrator to check the Gemini key, then try again.';

const RECOVERY_PANEL = path.join(process.cwd(), 'components/workspace/RecoveryPanel.tsx');
const CHAT_PANEL = path.join(process.cwd(), 'components/workspace/ChatPanel.tsx');

describe('recovery panel prefers the recorded provider sentence', () => {
  it('shows the Gemini key-rejection sentence when the job recorded it', () => {
    expect(recoveryCauseLine('provider_not_configured', GEMINI_KEY_REJECTED)).toBe(
      GEMINI_KEY_REJECTED,
    );
    expect(jobAdminFailureLine({ lastStep: 'generate', errorMessage: GEMINI_KEY_REJECTED })).toBe(
      GEMINI_KEY_REJECTED,
    );
    expect(recoveryCauseLine('provider_not_configured', GEMINI_KEY_REJECTED)).toBe(
      jobAdminFailureLine({ lastStep: 'generate', errorMessage: GEMINI_KEY_REJECTED }),
    );
    expect(recoveryCauseLine('provider_not_configured', GEMINI_KEY_REJECTED)).not.toBe(
      NO_PROVIDER_CONFIGURED_MESSAGE,
    );
  });

  it('still uses the original no-provider wording when nothing specific was recorded', () => {
    expect(recoveryCauseLine('provider_not_configured')).toBe(NO_PROVIDER_CONFIGURED_MESSAGE);
    expect(recoveryCauseLine('provider_not_configured', null)).toBe(NO_PROVIDER_CONFIGURED_MESSAGE);
    expect(recoveryCauseLine('provider_not_configured', '   ')).toBe(NO_PROVIDER_CONFIGURED_MESSAGE);
    expect(recoveryCauseLine('provider_not_configured', NO_PROVIDER_CONFIGURED_MESSAGE)).toBe(
      NO_PROVIDER_CONFIGURED_MESSAGE,
    );
    expect(recoveryNextStepLine({ errorCode: 'provider_not_configured' })).toBe(
      NO_PROVIDER_CONFIGURED_MESSAGE,
    );
  });

  it('does not add a second generic no-provider line next to a recorded vendor sentence', () => {
    expect(
      recoveryNextStepLine({
        errorCode: 'provider_not_configured',
        errorMessage: GEMINI_KEY_REJECTED,
      }),
    ).toBe('');
  });

  it('the panel and chat pass the recorded errorMessage into recoveryCauseLine', () => {
    const panel = readFileSync(RECOVERY_PANEL, 'utf8');
    expect(panel).toMatch(/errorMessage\?:/);
    expect(panel).toMatch(/recoveryCauseLine\(errorCode,\s*errorMessage\)/);
    const chat = readFileSync(CHAT_PANEL, 'utf8');
    expect(chat).toMatch(/errorMessage=\{recovery\.errorMessage\}/);
  });
});
