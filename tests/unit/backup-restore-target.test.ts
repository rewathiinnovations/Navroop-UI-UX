import { describe, expect, it } from 'vitest';
import { assertRestoreTarget } from '@/lib/backup/assert';

/**
 * F-701: `assertRestoreTarget` is the only thing standing between a mistyped env file and
 * `pg_restore` running against production. Postgres reaches the *same* database through many
 * spellings — `postgres://` vs `postgresql://`, an implicit vs explicit `:5432`, an
 * upper-cased hostname, a trailing slash, an encoded database name — so the guard must
 * compare the resolved connection identity (host, port, database), never the URL text.
 *
 * Goes red if: any same-database spelling below stops being refused; a URL the guard cannot
 * parse is waved through instead of refused (fail-open); or a genuinely different database
 * name is refused (which would make the guard impossible to satisfy and invite operators to
 * bypass it).
 */

const LIVE = 'postgresql://navroop:secret@postgres:5432/navroop';
const REFUSAL = /must differ from DATABASE_URL/;
const UNREADABLE = /refusing/;

describe('assertRestoreTarget refuses every spelling of the live database', () => {
  it('refuses postgres:// vs postgresql:// for the same database', () => {
    expect(() =>
      assertRestoreTarget(LIVE, 'postgres://navroop:secret@postgres:5432/navroop'),
    ).toThrow(REFUSAL);
  });

  it('refuses an implicit port against an explicit :5432', () => {
    expect(() => assertRestoreTarget(LIVE, 'postgresql://navroop:secret@postgres/navroop')).toThrow(
      REFUSAL,
    );
    // And the mirror image: the live URL omits the port, the restore URL states it.
    expect(() =>
      assertRestoreTarget(
        'postgresql://navroop:secret@postgres/navroop',
        'postgres://navroop:secret@postgres:5432/navroop',
      ),
    ).toThrow(REFUSAL);
  });

  it('refuses when only the credentials are spelled differently (encoded password)', () => {
    // Same (host, port, database); the password is written encoded on one side. Credentials
    // do not change which database pg_restore lands in, so this is still the live database.
    expect(() =>
      assertRestoreTarget(LIVE, 'postgres://navroop:s%65cret@postgres:5432/navroop'),
    ).toThrow(REFUSAL);
    expect(() =>
      assertRestoreTarget(
        'postgresql://navroop:p%40ss@postgres:5432/navroop',
        'postgres://navroop:pass@postgres:5432/navroop',
      ),
    ).toThrow(REFUSAL);
  });

  it('refuses a trailing slash and an encoded database name', () => {
    expect(() =>
      assertRestoreTarget(LIVE, 'postgres://navroop:secret@postgres:5432/navroop/'),
    ).toThrow(REFUSAL);
    expect(() =>
      assertRestoreTarget(LIVE, 'postgres://navroop:secret@postgres:5432/%6Eavroop'),
    ).toThrow(REFUSAL);
  });

  it('refuses a hostname that differs only in case', () => {
    expect(() =>
      assertRestoreTarget(LIVE, 'postgres://navroop:secret@POSTGRES:5432/navroop'),
    ).toThrow(REFUSAL);
  });
});

describe('assertRestoreTarget fails closed on anything it cannot read', () => {
  it('refuses a RESTORE_DATABASE_URL that is not a URL at all', () => {
    expect(() => assertRestoreTarget(LIVE, 'not-a-url')).toThrow(UNREADABLE);
  });

  it('refuses a non-postgres scheme', () => {
    expect(() => assertRestoreTarget(LIVE, 'mysql://navroop:secret@postgres:5432/navroop')).toThrow(
      UNREADABLE,
    );
  });

  it('refuses a URL without a database name', () => {
    expect(() => assertRestoreTarget(LIVE, 'postgresql://navroop:secret@postgres:5432/')).toThrow(
      UNREADABLE,
    );
  });

  it('refuses when DATABASE_URL itself is unreadable', () => {
    expect(() =>
      assertRestoreTarget('not-a-url', 'postgresql://navroop:secret@elsewhere:5432/restore'),
    ).toThrow(UNREADABLE);
  });

  it('still requires both variables to be set', () => {
    // Empty strings bypass the parameter defaults; the unset-env path is exercised through
    // `restoreDbBackup` in backup-db-run.test.ts, where the process env is controlled.
    expect(() => assertRestoreTarget(LIVE, '')).toThrow('RESTORE_DATABASE_URL is required');
    expect(() => assertRestoreTarget(LIVE, '  ')).toThrow('RESTORE_DATABASE_URL is required');
    expect(() => assertRestoreTarget('', LIVE)).toThrow('DATABASE_URL is required');
  });
});

describe('assertRestoreTarget accepts a genuinely different target', () => {
  it('accepts a different database name on the same server', () => {
    expect(() =>
      assertRestoreTarget(LIVE, 'postgresql://navroop:secret@postgres:5432/navroop_restore'),
    ).not.toThrow();
  });

  it('accepts the same database name on a different host or port', () => {
    expect(() =>
      assertRestoreTarget(LIVE, 'postgresql://navroop:secret@restore-host:5432/navroop'),
    ).not.toThrow();
    expect(() =>
      assertRestoreTarget(LIVE, 'postgresql://navroop:secret@postgres:5433/navroop'),
    ).not.toThrow();
  });
});
