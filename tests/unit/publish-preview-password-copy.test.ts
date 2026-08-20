import { describe, expect, it } from 'vitest';
import { PREVIEW_SIGN_IN_HINT, previewPasswordNotice } from '@/lib/publish/preview-password-copy';

/**
 * What the publish sheet is allowed to say after a preview-password change.
 *
 * The change used to be synchronous for every stack, so "Password protection on." was true
 * by the time the toast rendered. It is not any more: a node stack needs a build to carry
 * the gate and the value it compares against into the running container, and that build now
 * runs in the background (F-232). Claiming the preview is protected while the container is
 * still serving the old middleware is the same class of lie the rollback copy was fixed for.
 *
 * The username is part of the message because both gates demand `preview` and the sheet
 * never said so — Traefik has always enforced it on the static path, and the node gate does
 * now too (F-231).
 */

const RUNNING = { kind: 'PUBLISH', status: 'RUNNING' } as const;
const QUEUED = { kind: 'PUBLISH', status: 'QUEUED' } as const;
const DONE = { kind: 'PUBLISH', status: 'SUCCEEDED' } as const;

describe('previewPasswordNotice', () => {
  it('says the change is in force when nothing has to be rebuilt', () => {
    expect(previewPasswordNotice('a-passphrase', null)).toEqual({
      tone: 'success',
      message: `Password protection on. ${PREVIEW_SIGN_IN_HINT}`,
    });
  });

  it('does not claim protection while the build carrying the gate is still running', () => {
    const notice = previewPasswordNotice('a-passphrase', RUNNING);

    expect(notice.tone).toBe('info');
    expect(notice.message).toMatch(/republish/i);
    expect(notice.message).not.toMatch(/protection on/i);
  });

  it('treats a queued build the same as a running one', () => {
    expect(previewPasswordNotice('a-passphrase', QUEUED).tone).toBe('info');
  });

  it('does not claim the gate is off while the build removing it is still running', () => {
    const notice = previewPasswordNotice(null, RUNNING);

    expect(notice.tone).toBe('info');
    expect(notice.message).toMatch(/republish/i);
    expect(notice.message).not.toMatch(/protection off/i);
  });

  it('reports removal plainly once no build is pending', () => {
    expect(previewPasswordNotice(null, DONE)).toEqual({
      tone: 'success',
      message: 'Password protection off.',
    });
  });

  it('ignores a job of another kind', () => {
    // A generation running alongside says nothing about whether the gate is deployed.
    expect(previewPasswordNotice('a-passphrase', { kind: 'BUILD', status: 'RUNNING' }).tone).toBe(
      'success',
    );
  });

  it('names the account both gates actually require', () => {
    expect(PREVIEW_SIGN_IN_HINT).toContain('preview');
  });
});
