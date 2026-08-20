import { describe, expect, it, vi } from 'vitest';
import { createPrismaCronClaimStore, cronClaimKey, cronClaimStaleMs } from '@/lib/cron/claim';
import { handleCron } from '@/lib/cron/handle';

/**
 * Overlap protection and the record a dead run owes the operator (F-708).
 *
 * `handleCron` used to authorise and invoke the body immediately: no lock, no in-flight
 * marker, no dedupe key. A scheduler retry, a slow `reap-jobs` overlapping the next minute
 * tick, a second replica or an operator curling the endpoint all ran the work twice —
 * two `pg_dump`s into the same volume, two `adjustStorageBytes(-bytes)` for one project.
 * And because `withCronRun` writes its row only once the body settles, a run whose process
 * was killed left no row at all, which reads on /admin/health exactly like "never scheduled".
 *
 * The claim is an `AppSetting` row taken before the work and dropped after it. Postgres is
 * modelled here by a fake that serialises transactions the way `pg_advisory_xact_lock` does,
 * and a separate assertion pins that the lock is actually acquired — without it two replicas
 * could both read "no claim" and both insert.
 */

const SECRET = 'cron-test';

type Row = { value: string };

function fakeDb() {
  const rows = new Map<string, string>();
  const locks: unknown[] = [];
  let tail: Promise<unknown> = Promise.resolve();

  const tx = {
    async $executeRaw(_query: TemplateStringsArray, ...values: unknown[]) {
      locks.push(values[0]);
      return 1;
    },
    appSetting: {
      async findUnique({ where }: { where: { key: string } }): Promise<Row | null> {
        const value = rows.get(where.key);
        return value === undefined ? null : { value };
      },
      async upsert({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: { key: string; value: string };
        update: { value: string };
      }) {
        rows.set(where.key, rows.has(where.key) ? update.value : create.value);
        return null;
      },
      async deleteMany({ where }: { where: { key: string; value: string } }) {
        if (rows.get(where.key) !== where.value) return { count: 0 };
        rows.delete(where.key);
        return { count: 1 };
      },
    },
  };

  return {
    ...tx,
    // A transaction-scoped advisory lock serialises the claim decision across connections.
    // The queue models that: overlapping claims cannot interleave their read and write.
    $transaction<R>(fn: (client: typeof tx) => Promise<R>): Promise<R> {
      const run = tail.then(() => fn(tx));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    rows,
    locks,
  };
}

function cronRequest(authorization = `Bearer ${SECRET}`, requestId?: string) {
  const headers: Record<string, string> = { authorization };
  if (requestId) headers['x-request-id'] = requestId;
  return new Request('http://localhost:3000/api/cron/reap-jobs', { method: 'POST', headers });
}

function harness(now: () => Date) {
  const db = fakeDb();
  const recorded: Array<{ name: string; ok: boolean; detail: string | null }> = [];
  const store = {
    async createCronRun(row: {
      name: string;
      ok: boolean;
      detail?: string | null;
      durationMs?: number | null;
      createdAt: Date;
    }) {
      recorded.push({ name: row.name, ok: row.ok, detail: row.detail ?? null });
      return { ...row, id: 'run', durationMs: row.durationMs ?? null, detail: row.detail ?? null };
    },
  };
  return { db, recorded, deps: { claims: createPrismaCronClaimStore(db), store, now } };
}

function withSecret<T>(fn: () => Promise<T>) {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });
}

const T0 = new Date('2026-08-20T12:00:00.000Z');

describe('cron overlap protection', () => {
  it('refuses a second concurrent run with 409 and never invokes its body', async () => {
    await withSecret(async () => {
      const { recorded, deps } = harness(() => T0);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const second = vi.fn(async () => ({ ok: true }));

      const first = handleCron(
        'reap-jobs',
        cronRequest(),
        async () => {
          await held;
          return { ok: true };
        },
        deps,
      );
      // Let the first claim settle before the second request arrives.
      await Promise.resolve();
      await Promise.resolve();

      const blocked = await handleCron('reap-jobs', cronRequest(), second, deps);
      expect(blocked.status).toBe(409);
      expect(second).not.toHaveBeenCalled();
      const body = (await blocked.json()) as { error: { message: string; code: string } };
      expect(body.error.code).toBe('CRON_ALREADY_RUNNING');
      expect(body.error.message).toContain('reap-jobs');
      // A refused request did no work; the run that holds the claim writes the only row.
      expect(recorded).toEqual([]);

      release();
      expect((await first).status).toBe(200);
      expect(recorded).toEqual([{ name: 'reap-jobs', ok: true, detail: null }]);
    });
  });

  it('threads the inbound request id onto the 409', async () => {
    await withSecret(async () => {
      const { deps } = harness(() => T0);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = handleCron(
        'reap-jobs',
        cronRequest(),
        async () => {
          await held;
          return { ok: true };
        },
        deps,
      );
      await Promise.resolve();
      await Promise.resolve();

      const blocked = await handleCron(
        'reap-jobs',
        cronRequest(`Bearer ${SECRET}`, 'cron-inbound-9'),
        async () => ({ ok: true }),
        deps,
      );
      expect(blocked.headers.get('x-request-id')).toBe('cron-inbound-9');
      release();
      await first;
    });
  });

  it('releases the claim when the body resolves so the next tick runs', async () => {
    await withSecret(async () => {
      const { db, deps } = harness(() => T0);
      const ran = vi.fn(async () => ({ ok: true }));

      expect((await handleCron('reap-jobs', cronRequest(), ran, deps)).status).toBe(200);
      expect(db.rows.has(cronClaimKey('reap-jobs'))).toBe(false);
      expect((await handleCron('reap-jobs', cronRequest(), ran, deps)).status).toBe(200);
      expect(ran).toHaveBeenCalledTimes(2);
    });
  });

  it('releases the claim when the body throws', async () => {
    await withSecret(async () => {
      const { db, deps } = harness(() => T0);

      const response = await handleCron(
        'reap-jobs',
        cronRequest(),
        async () => {
          throw new Error('boom');
        },
        deps,
      );
      expect(response.status).toBe(500);
      expect(db.rows.has(cronClaimKey('reap-jobs'))).toBe(false);
    });
  });

  it('does not claim, or record, an unauthorized request', async () => {
    await withSecret(async () => {
      const { db, recorded, deps } = harness(() => T0);
      const response = await handleCron(
        'reap-jobs',
        cronRequest('Bearer wrong'),
        async () => ({ ok: true }),
        deps,
      );
      expect(response.status).toBe(401);
      expect(db.rows.size).toBe(0);
      expect(recorded).toEqual([]);
    });
  });

  it('takes a transaction-scoped advisory lock on the claim key', async () => {
    await withSecret(async () => {
      const { db, deps } = harness(() => T0);
      await handleCron('reap-jobs', cronRequest(), async () => ({ ok: true }), deps);
      expect(db.locks).toContain(cronClaimKey('reap-jobs'));
    });
  });
});

describe('a cron run that died', () => {
  /**
   * A killed process leaves exactly one trace: a claim nobody released. That is planted
   * through the store rather than by hanging a `handleCron` body, so the state under test is
   * the state a SIGKILL actually leaves and the test does not depend on tick counting.
   */
  it('is settled as a failed CronRun by the next invocation, which then proceeds', async () => {
    await withSecret(async () => {
      let now = T0;
      const { db, recorded, deps } = harness(() => now);
      await deps.claims.claim('reap-jobs', T0);
      expect(db.rows.has(cronClaimKey('reap-jobs'))).toBe(true);

      now = new Date(T0.getTime() + cronClaimStaleMs('reap-jobs') + 1);
      const ran = vi.fn(async () => ({ ok: true }));
      const response = await handleCron('reap-jobs', cronRequest(), ran, deps);

      expect(response.status).toBe(200);
      expect(ran).toHaveBeenCalledTimes(1);
      expect(recorded[0]?.ok).toBe(false);
      expect(recorded[0]?.detail).toContain(T0.toISOString());
      expect(recorded[0]?.detail).toMatch(/never reported an outcome/i);
      expect(recorded[1]).toEqual({ name: 'reap-jobs', ok: true, detail: null });
      // The replacement run released its own claim on the way out.
      expect(db.rows.has(cronClaimKey('reap-jobs'))).toBe(false);
    });
  });

  it('is still treated as running inside the stale window', async () => {
    await withSecret(async () => {
      let now = T0;
      const { recorded, deps } = harness(() => now);
      await deps.claims.claim('reap-jobs', T0);

      now = new Date(T0.getTime() + cronClaimStaleMs('reap-jobs') - 1);
      const body = vi.fn(async () => ({ ok: true }));
      const blocked = await handleCron('reap-jobs', cronRequest(), body, deps);

      expect(blocked.status).toBe(409);
      expect(body).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    });
  });

  it('does not let the abandoned run delete the claim of the run that replaced it', async () => {
    await withSecret(async () => {
      let now = T0;
      const { db, deps } = harness(() => now);
      const claims = deps.claims;

      const first = await claims.claim('reap-jobs', now);
      expect(first.claimed).toBe(true);
      if (!first.claimed) return;

      now = new Date(T0.getTime() + cronClaimStaleMs('reap-jobs') + 1);
      const second = await claims.claim('reap-jobs', now);
      expect(second.claimed).toBe(true);
      if (!second.claimed) return;
      expect(second.abandoned?.startedAt).toBe(T0.toISOString());

      // The zombie finally unwinds and releases. It must not take the live claim with it.
      await first.claim.release();
      expect(db.rows.get(cronClaimKey('reap-jobs'))).toContain(second.claim.runId);

      await second.claim.release();
      expect(db.rows.has(cronClaimKey('reap-jobs'))).toBe(false);
    });
  });

  it('still answers with the run result when releasing the claim fails', async () => {
    await withSecret(async () => {
      const { deps } = harness(() => T0);
      const claims: typeof deps.claims = {
        claim: async (name, now) => {
          const taken = await deps.claims.claim(name, now);
          if (!taken.claimed) return taken;
          return {
            ...taken,
            claim: {
              ...taken.claim,
              release: async () => {
                throw new Error('connection terminated');
              },
            },
          };
        },
      };

      // A cleanup DELETE that did not land must not turn a healthy run into a 500; the next
      // invocation settles the leftover claim on its own.
      const response = await handleCron(
        'reap-jobs',
        cronRequest(),
        async () => ({ ok: true, reaped: 1 }),
        { ...deps, claims },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, reaped: 1 });
    });
  });

  it('releases the claim even when writing the abandoned run fails', async () => {
    await withSecret(async () => {
      let now = T0;
      const { db, deps } = harness(() => now);
      await deps.claims.claim('reap-jobs', T0);
      now = new Date(T0.getTime() + cronClaimStaleMs('reap-jobs') + 1);

      const response = await handleCron('reap-jobs', cronRequest(), async () => ({ ok: true }), {
        ...deps,
        store: {
          createCronRun: async () => {
            throw new Error('CronRun insert failed');
          },
        },
      });

      expect(response.status).toBe(500);
      // Otherwise one failed insert wedges the schedule for a whole stale window.
      expect(db.rows.has(cronClaimKey('reap-jobs'))).toBe(false);
    });
  });
});

describe('claim staleness budgets', () => {
  it('gives the minute-tick crons a short budget and the dump crons a long one', () => {
    expect(cronClaimStaleMs('reap-jobs')).toBeLessThan(cronClaimStaleMs('backup-db'));
    expect(cronClaimStaleMs('verify-storage')).toBeGreaterThan(cronClaimStaleMs('check-domains'));
    // An unlisted name must still get a finite budget, or a killed run wedges it forever.
    expect(cronClaimStaleMs('not-a-cron')).toBeGreaterThan(0);
  });
});
