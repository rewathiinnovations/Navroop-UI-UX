import { beforeEach, describe, expect, it } from 'vitest';
import { allowEmail, clearEmailRateLimits } from '@/lib/email/rate-limit';
import { passwordChangedEmail } from '@/lib/email/templates/password-changed';
import { passwordResetEmail } from '@/lib/email/templates/password-reset';
import { spendAlert80Email } from '@/lib/email/templates/spend-alert';

/**
 * Account-recovery mail must not queue behind routine notifications.
 *
 * `allowEmail` gives every recipient 20 emails an hour and exempts only `emailClass:
 * 'security'`. The observability alerts opt in; the reset link and the password-changed
 * warning did not, so an admin who also receives spend alerts, DNS notices and backup
 * failures at the same address could cross the ceiling and have their reset link dropped —
 * with the UI still showing "a link has been sent" and nothing but a server-side
 * `console.error` to say otherwise. Losing a reset link is losing the account.
 */

beforeEach(() => {
  clearEmailRateLimits();
});

/** Fills a recipient's hourly workspace bucket. */
function fillBucket(to: string) {
  for (let i = 0; i < 20; i += 1) {
    expect(allowEmail({ to, emailClass: 'workspace' }).allowed).toBe(true);
  }
  expect(allowEmail({ to, emailClass: 'workspace' }).allowed).toBe(false);
}

describe('password mail', () => {
  it('still goes out to a recipient whose hourly bucket is full', () => {
    const to = 'admin@example.com';
    fillBucket(to);

    const reset = passwordResetEmail('https://navroop.test/reset-password?token=abc');
    const changed = passwordChangedEmail();

    expect(allowEmail({ to, emailClass: reset.emailClass }).allowed).toBe(true);
    expect(allowEmail({ to, emailClass: changed.emailClass }).allowed).toBe(true);
  });

  it('is classed security by the templates themselves, not by the caller', () => {
    // The class travels with the template because `sendEmail({ to, ...mail })` is how every
    // caller spreads it; a caller that has to remember the class is a caller that forgets.
    expect(passwordResetEmail('https://navroop.test/reset-password?token=abc').emailClass).toBe(
      'security',
    );
    expect(passwordChangedEmail().emailClass).toBe('security');
  });

  it('does not exempt routine workspace notifications along with it', () => {
    const to = 'admin@example.com';
    fillBucket(to);

    // The bucket still has to mean something, or a noisy integration can bury everything.
    const alert = spendAlert80Email({ used: 42, limit: 50 });
    expect(allowEmail({ to, emailClass: alert.emailClass }).allowed).toBe(false);
  });
});
