import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHADOW_DATABASE_NAME,
  DEFAULT_SHADOW_DATABASE_URL,
  ShadowDatabaseError,
  isSchemaDriftCommand,
  prismaMigrateDiffCommand,
  prismaValidateCommand,
  resolveShadowDatabaseUrl,
} from '../../lib/verify/schema-drift';

const APP = 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable';
const TEST = 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test';
const SHADOW = 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_shadow';

describe('schema drift shadow URL', () => {
  it('derives openlovable_shadow from TEST_DATABASE_URL and never uses the app or test DB', () => {
    expect(
      resolveShadowDatabaseUrl({
        DATABASE_URL: APP,
        TEST_DATABASE_URL: TEST,
      }),
    ).toBe(SHADOW);

    expect(() =>
      resolveShadowDatabaseUrl({
        DATABASE_URL: APP,
        TEST_DATABASE_URL: TEST,
        SHADOW_DATABASE_URL: APP,
      }),
    ).toThrow(ShadowDatabaseError);

    expect(() =>
      resolveShadowDatabaseUrl({
        DATABASE_URL: APP,
        TEST_DATABASE_URL: TEST,
        SHADOW_DATABASE_URL: TEST,
      }),
    ).toThrow(/TEST_DATABASE_URL/);
  });

  it('uses SHADOW_DATABASE_URL when it is a dedicated database', () => {
    const custom = 'postgresql://openlovable:openlovable@127.0.0.1:5433/custom_shadow';
    expect(
      resolveShadowDatabaseUrl({
        DATABASE_URL: APP,
        TEST_DATABASE_URL: TEST,
        SHADOW_DATABASE_URL: custom,
      }),
    ).toBe(custom);
  });

  it('includes --shadow-database-url on the migrate diff command', () => {
    const command = prismaMigrateDiffCommand();
    expect(command).toContain(
      'prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code',
    );
    expect(command).toContain('--shadow-database-url');
    expect(command).toContain('$SHADOW_DATABASE_URL');
    expect(DEFAULT_SHADOW_DATABASE_NAME).toBe('openlovable_shadow');
    expect(isSchemaDriftCommand(command)).toBe(true);
    expect(isSchemaDriftCommand(prismaValidateCommand())).toBe(false);
    expect(prismaValidateCommand()).toBe('pnpm exec prisma validate');
  });

  it('derives the shadow URL from DATABASE_URL, then the built-in default', () => {
    expect(
      resolveShadowDatabaseUrl({
        DATABASE_URL: APP,
      }),
    ).toBe(SHADOW);
    expect(resolveShadowDatabaseUrl({})).toBe(DEFAULT_SHADOW_DATABASE_URL);
  });

  it('treats host-only URLs as the same database when the name matches', () => {
    expect(() =>
      resolveShadowDatabaseUrl({
        DATABASE_URL: 'postgresql://openlovable:openlovable@127.0.0.1/openlovable_shadow',
        SHADOW_DATABASE_URL: 'postgresql://openlovable:openlovable@127.0.0.1:5432/openlovable_shadow',
      }),
    ).toThrow(/must not be DATABASE_URL/);
  });
});
