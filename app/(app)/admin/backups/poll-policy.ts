/**
 * F-431: the backups page polls `/api/admin/backups` every two seconds while a
 * backup is running, and `refresh()` had no `try/catch`. `await response.json()`
 * throws on a non-JSON body, so interrupting the API produced an unhandled
 * rejection every two seconds while the page kept promising "Backup in
 * progress. This page refreshes automatically." — a banner describing a refresh
 * that had stopped working.
 *
 * The policy is pure so the give-up behaviour is testable without a DOM: the
 * component owns the timer, this owns the decision.
 */

export const BACKUP_POLL_INTERVAL_MS = 2000;

/** Transient failures tolerated before the poll gives up and says so. */
export const BACKUP_POLL_MAX_FAILURES = 3;

export const BACKUP_POLL_GAVE_UP =
  'Could not refresh the backup status — reload the page to see where it got to.';

/**
 * `terminal` covers a failure that retrying cannot fix (access removed):
 * re-polling a 403 forever is noise, so it stops the timer on the first one.
 */
export type PollOutcome = 'ok' | 'transient' | 'terminal';

export type PollState = { failures: number; stopped: boolean; message: string };

export function decidePoll(input: {
  failures: number;
  outcome: PollOutcome;
  /** What went wrong, for a `transient` or `terminal` outcome. */
  message?: string;
}): PollState {
  if (input.outcome === 'ok') return { failures: 0, stopped: false, message: '' };
  if (input.outcome === 'terminal') {
    return {
      failures: input.failures,
      stopped: true,
      message: input.message || BACKUP_POLL_GAVE_UP,
    };
  }

  const failures = input.failures + 1;
  const stopped = failures >= BACKUP_POLL_MAX_FAILURES;
  return {
    failures,
    stopped,
    // The last transient reason is worth showing while there is still a retry
    // coming; once the poll has given up, the page has to say the refresh
    // stopped, because the "refreshes automatically" banner no longer holds.
    message: stopped ? BACKUP_POLL_GAVE_UP : input.message || 'Could not refresh the backup status',
  };
}
