import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRON_STALE_MS } from '../../lib/observability/system-checks';

/**
 * Both directions of the monitor↔route↔schedule mapping.
 *
 * A monitored name with no route is reported `never-run` forever and mails every admin on
 * every digest — `reap-sandboxes` did that until its dead entry was removed, and the cost is
 * an operator who has learned to ignore the mail. A route with no monitor is the opposite
 * failure and just as expensive: `thin-checkpoints` was unmonitored, so when one poisoned
 * snapshot key aborted the whole daily maintenance cron on every run, nothing said so until
 * the volume filled.
 *
 * Goes red if: a name is added to `CRON_STALE_MS` without a route, a route is deleted while
 * its monitor stays, a new cron route ships unmonitored, or the docs cron table drifts from
 * the routes that exist.
 */

const CRON_DIR = join(process.cwd(), 'app', 'api', 'cron');

/**
 * The one route deliberately outside `CRON_STALE_MS`: it is the sender, so it cannot report
 * its own silence. `docs/coolify.md` carries the external dead-man's-switch instruction, and
 * that note is asserted below so the exemption cannot quietly become an oversight.
 */
const SELF_MONITORING_EXEMPT = ['system-checks-digest'];

const routeNames = readdirSync(CRON_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(CRON_DIR, entry.name, 'route.ts')))
  .map((entry) => entry.name)
  .sort();

describe('cron monitor coverage', () => {
  it('finds the cron routes at all', () => {
    // Without this the whole suite passes vacuously if the directory ever moves.
    expect(routeNames.length).toBeGreaterThan(10);
  });

  it('has a route implementing every monitored name, under that exact name', () => {
    for (const name of Object.keys(CRON_STALE_MS)) {
      expect(routeNames, `${name} is monitored but has no route`).toContain(name);
      const source = readFileSync(join(CRON_DIR, name, 'route.ts'), 'utf8');
      // The monitor keys off the string passed to handleCron, not the directory name.
      expect(source, `${name}/route.ts does not call handleCron('${name}', …)`).toContain(
        `handleCron('${name}'`,
      );
    }
  });

  it('monitors every cron route except the digest itself', () => {
    const unmonitored = routeNames.filter(
      (name) => !(name in CRON_STALE_MS) && !SELF_MONITORING_EXEMPT.includes(name),
    );
    expect(unmonitored).toEqual([]);
  });

  it('gives every monitored name a staleness budget looser than its schedule', () => {
    const docs = readFileSync(join(process.cwd(), 'docs', 'coolify.md'), 'utf8');
    const scheduled = new Map(
      [...docs.matchAll(/\|\s*([^|]+?)\s*\|\s*`POST \/api\/cron\/([a-z-]+)`\s*\|/g)].map((row) => [
        row[2],
        row[1].trim(),
      ]),
    );
    // Every route is scheduled and every scheduled task exists: a curl block and a table that
    // name routes nobody implements is how an operator ends up with a cron that never runs.
    expect([...scheduled.keys()].sort()).toEqual(routeNames);

    const budgetFor: Record<string, number> = {
      'Every minute': 60_000,
      'Every 2 minutes': 2 * 60_000,
      'Every 10 minutes': 10 * 60_000,
      Hourly: 60 * 60_000,
      Daily: 24 * 60 * 60_000,
      'Daily 02:00': 24 * 60 * 60_000,
      Weekly: 7 * 24 * 60 * 60_000,
    };
    for (const [name, staleMs] of Object.entries(CRON_STALE_MS)) {
      const interval = budgetFor[scheduled.get(name) ?? ''];
      expect(
        interval,
        `${name} has schedule "${scheduled.get(name)}" with no known interval`,
      ).toBeGreaterThan(0);
      // A budget at or under the interval is red between two healthy runs, which is the same
      // alert fatigue as a name with no route.
      expect(staleMs, `${name} goes stale before its next scheduled run`).toBeGreaterThan(interval);
    }
  });

  it('README and .env.example schedule only cron routes that exist', () => {
    // README.md's curl blocks and .env.example's schedule list are the two places an
    // operator copies schedules from. Both carried `reap-sandboxes` /
    // `check-sandbox-providers` long after those routes were deleted (F-521 / F-717) —
    // two permanently-404 tasks that train the operator to ignore cron alerts.
    for (const file of ['README.md', '.env.example']) {
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      const named = [...text.matchAll(/\/api\/cron\/([a-z-]+)/g)].map((row) => row[1]);
      const missing = [...new Set(named)].filter((name) => !routeNames.includes(name));
      expect(missing, `${file} schedules cron routes that do not exist`).toEqual([]);
    }
  });

  it('tells the operator how to monitor the digest, since it cannot monitor itself', () => {
    const docs = readFileSync(join(process.cwd(), 'docs', 'coolify.md'), 'utf8');
    expect(docs).toMatch(/dead-man's-switch/);
    for (const name of SELF_MONITORING_EXEMPT) {
      expect(docs).toContain(name);
    }
  });
});
