/**
 * One-shot backfill for D2 / F-300: wrap every stored ApiKey/OrgApiKey secret
 * in the enc:v1 envelope, in place. Idempotent — rows already carrying the
 * envelope are skipped, so running it twice (or during a deploy retry) is safe.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/encrypt-api-keys.ts
 *
 * Requires ENCRYPTION_KEY (the same one the app runs with). Legacy rows that
 * are old-format bare ciphertext are decrypted and re-wrapped; anything that
 * does not decrypt is treated as pre-encryption plaintext and encrypted as-is.
 * `last4` is untouched — it was derived from the plaintext at write time.
 */
import { config } from 'dotenv';
import { pathToFileURL } from 'node:url';
import { decrypt, encrypt, isEncrypted } from '../lib/crypto';

type SecretRow = { id: string; provider: string; secret: string };

type SecretTable = {
  findMany(args: { select: { id: true; provider: true; secret: true } }): Promise<SecretRow[]>;
  update(args: { where: { id: string }; data: { secret: string } }): Promise<unknown>;
};

export type BackfillReport = {
  table: string;
  total: number;
  alreadyEnveloped: number;
  reEncryptedFromLegacyCiphertext: number;
  encryptedFromPlaintext: number;
  /** Rows written this run. 0 on a repeat run — that is the idempotence check. */
  updated: number;
};

async function backfillTable(table: string, delegate: SecretTable): Promise<BackfillReport> {
  const rows = await delegate.findMany({
    select: { id: true, provider: true, secret: true },
  });
  const report: BackfillReport = {
    table,
    total: rows.length,
    alreadyEnveloped: 0,
    reEncryptedFromLegacyCiphertext: 0,
    encryptedFromPlaintext: 0,
    updated: 0,
  };

  for (const row of rows) {
    if (isEncrypted(row.secret)) {
      report.alreadyEnveloped += 1;
      continue;
    }
    let plaintext: string;
    try {
      // Old-format bare ciphertext: decrypt so the value is wrapped once, not twice.
      plaintext = decrypt(row.secret);
      report.reEncryptedFromLegacyCiphertext += 1;
    } catch {
      // GCM authentication makes a false positive here practically impossible:
      // a value that decrypts was ciphertext; anything else is stored plaintext.
      plaintext = row.secret;
      report.encryptedFromPlaintext += 1;
    }
    await delegate.update({ where: { id: row.id }, data: { secret: encrypt(plaintext) } });
    report.updated += 1;
  }

  return report;
}

export async function runApiKeyBackfill(db: {
  apiKey: SecretTable;
  orgApiKey: SecretTable;
}): Promise<BackfillReport[]> {
  return [await backfillTable('ApiKey', db.apiKey), await backfillTable('OrgApiKey', db.orgApiKey)];
}

// Direct run only: the integration test imports `runApiKeyBackfill` and must
// not trigger a walk of whatever DATABASE_URL this process happens to carry.
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  config({ path: '.env' });
  config({ path: '.env.local', override: true });
  const { prisma } = await import('../lib/db');
  try {
    const reports = await runApiKeyBackfill(prisma);
    console.log(JSON.stringify(reports, null, 2));
  } catch (error) {
    console.error(`[encrypt-api-keys] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
