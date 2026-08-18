import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { ensurePostgresDatabase } from './ensure-db';

export const DEFAULT_SHADOW_DATABASE_NAME = 'openlovable_shadow';
export const DEFAULT_SHADOW_DATABASE_URL =
  'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_shadow';

export class ShadowDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShadowDatabaseError';
  }
}

function loadEnvFiles() {
  config({ path: resolve(process.cwd(), '.env'), quiet: true });
  config({ path: resolve(process.cwd(), '.env.local'), override: true, quiet: true });
}

function databaseNameFromUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    return decodeURIComponent(parsed.pathname.replace(/^\//, '')).split('?')[0] || '';
  } catch {
    return '';
  }
}

function swapDatabaseName(raw: string, name: string) {
  const parsed = new URL(raw);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function normalizeDb(raw: string) {
  try {
    const parsed = new URL(raw);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')).split('?')[0].toLowerCase();
    return {
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || '5432',
      database,
    };
  } catch {
    return { host: '', port: '', database: raw.trim().toLowerCase() };
  }
}

function sameDatabase(a?: string, b?: string) {
  if (!a?.trim() || !b?.trim()) return false;
  const left = normalizeDb(a);
  const right = normalizeDb(b);
  return left.host === right.host && left.port === right.port && left.database === right.database;
}

export function resolveShadowDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const appUrl = env.DATABASE_URL?.trim();
  const testUrl = env.TEST_DATABASE_URL?.trim();
  const explicit = env.SHADOW_DATABASE_URL?.trim();

  const shadowUrl = explicit
    ? explicit
    : testUrl
      ? swapDatabaseName(testUrl, DEFAULT_SHADOW_DATABASE_NAME)
      : appUrl
        ? swapDatabaseName(appUrl, DEFAULT_SHADOW_DATABASE_NAME)
        : DEFAULT_SHADOW_DATABASE_URL;

  if (sameDatabase(shadowUrl, appUrl)) {
    throw new ShadowDatabaseError(
      'Shadow database must not be DATABASE_URL. Prisma may wipe it. Use a dedicated name such as openlovable_shadow.',
    );
  }
  if (sameDatabase(shadowUrl, testUrl)) {
    throw new ShadowDatabaseError(
      'Shadow database must not be TEST_DATABASE_URL. Prisma may wipe it. Use a dedicated name such as openlovable_shadow.',
    );
  }
  return shadowUrl;
}

function adminUrlForShadow(shadowUrl: string, env: NodeJS.ProcessEnv) {
  const admin = env.TEST_DATABASE_ADMIN_URL?.trim();
  if (admin && !sameDatabase(admin, shadowUrl)) return admin;
  const testUrl = env.TEST_DATABASE_URL?.trim();
  if (testUrl && !sameDatabase(testUrl, shadowUrl)) return testUrl;
  const appUrl = env.DATABASE_URL?.trim();
  if (appUrl && !sameDatabase(appUrl, shadowUrl)) return appUrl;
  return swapDatabaseName(shadowUrl, 'postgres');
}

export function prismaValidateCommand() {
  return 'pnpm exec prisma validate';
}

export function prismaMigrateDiffCommand(shadowUrl = '$SHADOW_DATABASE_URL') {
  return `pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code --shadow-database-url ${shadowUrl}`;
}

export function isSchemaDriftCommand(command: string) {
  return command.includes('prisma migrate diff') && command.includes('--from-migrations');
}

export function runPrismaValidate() {
  const result = spawnSync('pnpm', ['exec', 'prisma', 'validate'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

export function runSchemaDriftCheck(env: NodeJS.ProcessEnv = process.env) {
  loadEnvFiles();
  let shadowUrl: string;
  try {
    shadowUrl = resolveShadowDatabaseUrl(env);
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }

  const name = databaseNameFromUrl(shadowUrl) || DEFAULT_SHADOW_DATABASE_NAME;
  const ensured = ensurePostgresDatabase({
    adminUrl: adminUrlForShadow(shadowUrl, env),
    name,
  });
  if (!ensured.ok) {
    return { ok: false, output: ensured.output };
  }

  const prismaCli = resolve(process.cwd(), 'node_modules/prisma/build/index.js');
  const result = spawnSync(
    process.execPath,
    [
      prismaCli,
      'migrate',
      'diff',
      '--from-migrations',
      'prisma/migrations',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--exit-code',
      '--shadow-database-url',
      shadowUrl,
    ],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );

  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}
