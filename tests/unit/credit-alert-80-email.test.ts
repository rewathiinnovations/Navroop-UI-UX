import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 80% credit alert actually leaves the process (F-306).
 *
 * `notifyAdminsCredit80` wrote its `credit-alert-80:` receipt, fetched the admin
 * recipients, `console.info`d and returned `true` — it never called `mailAdmins`. Its two
 * spend siblings in the same file always have. So no admin was ever told a workspace was
 * about to run out of credits; the first visible signal was generation being denied with
 * "This month's credits are used up". The `true` also told `consumeCredits` the alert had
 * been delivered, so the `creditAlert80Sent` claim stuck and no later debit retried — the
 * whole claim/hand-back machinery in `consumeCredits` was protecting a notification that
 * did not exist.
 *
 * `sendEmail` never throws; it reports `{ ok: false, error }`. That is why the third case
 * matters: a `.catch`-based reading of failure sees nothing, keeps the claim, and loses the
 * warning for the rest of the period.
 */

type MailInput = { to: string; subject: string; html: string; text: string };
type MailResult = { id: string } | { ok: false; error: string };

const sendEmail = vi.fn<(input: MailInput) => Promise<MailResult>>();
const findAdmins = vi.fn<() => Promise<Array<{ id: string; email: string }>>>();

vi.mock('@/lib/email/client', () => ({ sendEmail }));
vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: { upsert: async () => ({}) },
    user: { findMany: () => findAdmins() },
  },
}));

// Dynamic, not static: the mock factories above close over `sendEmail` and `findAdmins`,
// and a static import of the module under test would run them before those consts are
// initialised.
const { notifyAdminsCredit80 } = await import('@/lib/plans/alerts');

const INPUT = {
  workspaceId: 'default',
  used: 80,
  limit: 100,
  periodStart: new Date('2026-08-01T00:00:00.000Z'),
};

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ id: 'mail_1' });
  findAdmins.mockReset();
  findAdmins.mockResolvedValue([
    { id: 'u1', email: 'admin-one@example.com' },
    { id: 'u2', email: 'admin-two@example.com' },
  ]);
});

describe('notifyAdminsCredit80', () => {
  it('emails every active admin', async () => {
    expect(await notifyAdminsCredit80(INPUT)).toBe(true);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls.map(([input]) => input.to)).toEqual([
      'admin-one@example.com',
      'admin-two@example.com',
    ]);
  });

  it('says how much of the allowance is gone, in credits', async () => {
    await notifyAdminsCredit80(INPUT);

    const [first] = sendEmail.mock.calls[0];
    expect(first.subject).toContain("80% of this month's credits");
    expect(first.text).toContain('80 of its 100 monthly credits');
    // Credits are counted, not billed: a dollar figure here would be a different number
    // from the one Admin -> Workspace shows.
    expect(first.text).not.toContain('$');
  });

  it('reports false when a send fails, so the caller hands the claim back', async () => {
    sendEmail.mockResolvedValue({ ok: false, error: 'Email rate limit reached' });

    expect(await notifyAdminsCredit80(INPUT)).toBe(false);
  });

  it('reports true when there is no admin to warn', async () => {
    findAdmins.mockResolvedValue([]);

    // Nobody to tell is not a failed send. Returning false would hand the claim back and
    // re-attempt on every debit above the threshold for the rest of the period.
    expect(await notifyAdminsCredit80(INPUT)).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
