// TEMPORARY probe (F-315). Deleted before handoff. Test database only.
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '../generated/prisma/index.js';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local'), override: true });

const url = process.env.TEST_DATABASE_URL;
if (!url || !url.includes('openlovable_test')) throw new Error('need openlovable_test url');
const prisma = new PrismaClient({ datasources: { db: { url } } });

await prisma.$executeRawUnsafe(`ALTER TABLE "Workspace" ALTER COLUMN "storageBytes" TYPE BIGINT`);
await prisma.$executeRawUnsafe(
  `ALTER TABLE "Workspace" ALTER COLUMN "storageLimitBytes" TYPE BIGINT`,
);
const cols = await prisma.$queryRawUnsafe(
  `select column_name, data_type from information_schema.columns where table_name = 'Workspace' and column_name in ('storageBytes','storageLimitBytes')`,
);
console.log('columns now:', JSON.stringify(cols));

const BIG = 3_000_000_000;
console.log('--- model-API write of 3e9 against a BIGINT column, STALE client');
try {
  await prisma.workspace.upsert({
    where: { id: 'probe_f315' },
    create: { id: 'probe_f315', storageBytes: BIG },
    update: { storageBytes: BIG },
  });
  console.log('write ok');
} catch (error) {
  console.log('write FAILED:', String(error).split('\n').slice(0, 6).join(' | '));
}
console.log('--- raw write then model read');
await prisma.$executeRawUnsafe(
  `INSERT INTO "Workspace" ("id","storageBytes") VALUES ('probe_f315', 0) ON CONFLICT ("id") DO NOTHING`,
);
await prisma.$executeRawUnsafe(
  `UPDATE "Workspace" SET "storageBytes" = 3000000000 WHERE id = 'probe_f315'`,
);
try {
  const row = await prisma.workspace.findUnique({ where: { id: 'probe_f315' } });
  console.log('model read:', row && row.storageBytes, typeof (row && row.storageBytes));
} catch (error) {
  console.log('model read FAILED:', String(error).split('\n').slice(0, 6).join(' | '));
}
const raw = await prisma.$queryRawUnsafe(
  `SELECT "storageBytes" FROM "Workspace" WHERE id = 'probe_f315'`,
);
console.log(
  'raw read:',
  JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
);
console.log('--- increment via model API');
try {
  const r = await prisma.workspace.update({
    where: { id: 'probe_f315' },
    data: { storageBytes: { increment: 5 } },
  });
  console.log('increment ok ->', r.storageBytes);
} catch (error) {
  console.log('increment FAILED:', String(error).split('\n').slice(0, 6).join(' | '));
}

await prisma.$executeRawUnsafe(`DELETE FROM "Workspace" WHERE id = 'probe_f315'`);
await prisma.$disconnect();
