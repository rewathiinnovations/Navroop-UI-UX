const MIN_ENCRYPTION_KEY_BYTES = 32;

export type EnvAssertResult =
  | { ok: true }
  | { ok: false; missing: string[]; error: string };

export function assertReleaseEnv(env: NodeJS.ProcessEnv = process.env): EnvAssertResult {
  const missing: string[] = [];
  const encryptionKey = env.ENCRYPTION_KEY || '';
  const databaseUrl = env.DATABASE_URL || '';
  const appUrl = env.APP_URL || env.NEXTAUTH_URL || env.AUTH_URL || '';

  if (!databaseUrl.trim()) missing.push('DATABASE_URL');
  if (!appUrl.trim()) missing.push('APP_URL');
  if (!encryptionKey || Buffer.byteLength(encryptionKey, 'utf8') < MIN_ENCRYPTION_KEY_BYTES) {
    missing.push('ENCRYPTION_KEY');
  }

  if (missing.length === 0) return { ok: true };

  const details: string[] = [];
  if (missing.includes('DATABASE_URL')) details.push('DATABASE_URL is missing');
  if (missing.includes('APP_URL')) details.push('APP_URL is missing (NEXTAUTH_URL / AUTH_URL are accepted aliases)');
  if (missing.includes('ENCRYPTION_KEY')) {
    if (!encryptionKey) details.push('ENCRYPTION_KEY is missing (must be at least 32 bytes)');
    else details.push('ENCRYPTION_KEY is too short (must be at least 32 bytes)');
  }

  return {
    ok: false,
    missing,
    error: `Release env check failed: ${details.join('; ')}`,
  };
}

export function failClosedReleaseEnv(env: NodeJS.ProcessEnv = process.env) {
  const result = assertReleaseEnv(env);
  if (!result.ok) {
    throw new Error(result.error);
  }
}
