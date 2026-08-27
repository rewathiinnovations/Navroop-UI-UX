/**
 * The Quality poll's lifecycle, in one place because there are two of it.
 *
 * `useCodeAudit` and `useSeoAudit` are near-identical, and the rule about when to
 * poll is subtle enough that keeping a copy in each is how the last repair fixed
 * one hook and left the same defect in the other. Both hooks now import this
 * module and neither restates the rule.
 *
 * The poll had three jobs bolted onto one timer, and the three want different
 * answers:
 *
 *  1. **Watching a scan the user started.** The only thing the timer is really
 *     for. It ends when the scan ends, or when the server stops answering —
 *     never on a tick budget, because a budget that expires under a scan that is
 *     still running just stops reporting it.
 *  2. **Waiting for the project to gain files.** Not this timer's business at
 *     all. `PROJECT_FILES_CHANGED_EVENT` already fires in the browser when a
 *     generation settles or a checkpoint is restored, so the hooks listen for it
 *     and refresh once. A build can legitimately take many minutes, and the
 *     previous shape — a 30-tick, five-minute budget — turned that wait into a
 *     permanently disabled Scan button on a project that by then had a whole
 *     site: the interval cleared itself, nothing re-armed it (the effect's deps
 *     cannot move without a refresh), and the hint went on saying "Generate the
 *     project first" until the user switched views or reloaded.
 *  3. **Doing nothing.** Costs nothing: no timer exists while no scan is in
 *     flight.
 *
 * And a failing refresh is two different events, not one. A transient failure —
 * offline, a 500, a redeploy mid-flight — is worth retrying, backing off so a
 * struggling server is not hammered at 2s forever, and worth giving up on with
 * an explanation once it is clear nothing is coming back. A terminal one — the
 * project was deleted in another tab, the session cookie expired — is not going
 * to start working: asking again every 2 seconds for the life of the tab is the
 * unterminated poll this was all supposed to remove.
 */

/** Full-speed cadence while a scan the user can see is genuinely in flight. */
export const AUDIT_SCAN_POLL_MS = 2000;

/** First retry delay after a refresh fails; doubles per consecutive failure. */
export const AUDIT_RETRY_BASE_MS = 4000;

/** Ceiling for the backoff, so a long outage still costs about one read a minute. */
export const AUDIT_RETRY_MAX_MS = 60_000;

/**
 * Consecutive failed refreshes before the watch gives up and says so. Six spends
 * roughly two minutes (2s + 4 + 8 + 16 + 32 + 60) before admitting the server is
 * not answering, which is long enough to ride out a redeploy and short enough
 * that the user is not left watching a spinner that means nothing.
 */
export const AUDIT_GIVE_UP_AFTER = 6;

/** What the last refresh reported, from the poll's point of view. */
export type AuditRefreshOutcome = 'ok' | 'transient' | 'terminal';

export type AuditPollState = {
  /** The server said a scan is running (or the user has just started one). */
  scanning: boolean;
  /** Consecutive failed refreshes since the last one that answered. */
  failures: number;
  /** A refusal that will not change by asking again (deleted project, dead session). */
  stopped: boolean;
};

export type AuditPollDecision =
  | { poll: true; intervalMs: number }
  | { poll: false; reason: 'idle' | 'terminal' | 'unreachable' };

/**
 * Whether to run a timer at all, and how fast.
 *
 * Every "no" carries its reason, because the three are not interchangeable to
 * the person looking at the panel: `idle` is the normal resting state and says
 * nothing, while `terminal` and `unreachable` are the two ways a scan stops
 * being watched without finishing — and both of those owe the user a sentence.
 */
export function auditPollDecision(state: AuditPollState): AuditPollDecision {
  if (state.stopped) return { poll: false, reason: 'terminal' };
  // Not scanning is the resting state, and it is the only one that is free. The
  // "does this project have files yet" watch used to live here on a slow tier;
  // it is an event now, so nothing is left to watch between scans.
  if (!state.scanning) return { poll: false, reason: 'idle' };
  if (state.failures >= AUDIT_GIVE_UP_AFTER) return { poll: false, reason: 'unreachable' };
  if (state.failures <= 0) return { poll: true, intervalMs: AUDIT_SCAN_POLL_MS };
  const backoff = AUDIT_RETRY_BASE_MS * 2 ** (state.failures - 1);
  return { poll: true, intervalMs: Math.min(backoff, AUDIT_RETRY_MAX_MS) };
}

/**
 * A refusal the poll must not retry.
 *
 * `getLatestCodeAudit` / `getLatestSeoAudit` answer 401 when the session is gone
 * and 404 when the project is (soft-deleted rows are excluded from the lookup);
 * the mutations add 403. None of those become true again while this tab sits
 * there asking. Everything else — 5xx, a rejected fetch, an error with no status
 * — is worth another try.
 */
export function isTerminalAuditStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 404;
}

export const AUDIT_REFRESH_FAILED =
  'Could not load the latest scan. Check your connection and try again.';

export const AUDIT_UNREACHABLE =
  'We lost contact with the server while this scan was running. Reload the page to see whether it finished.';

/**
 * The server's own wording for a terminal refusal is accurate but not actionable
 * — "Project not found" on a panel the user is staring at reads as a bug rather
 * than as "this was deleted somewhere else". Each terminal status gets the next
 * step spelled out; anything unrecognised keeps the server's sentence rather
 * than inventing one.
 */
export function terminalAuditMessage(status: number | undefined, serverMessage: string): string {
  if (status === 401) {
    return 'Your session has expired, so the scan can no longer be followed. Reload the page and sign in again.';
  }
  if (status === 403) {
    return 'You no longer have access to this project, so its scans cannot be loaded.';
  }
  if (status === 404) {
    return 'This project no longer exists, so the scan stopped being followed. It may have been deleted in another tab.';
  }
  return serverMessage;
}
