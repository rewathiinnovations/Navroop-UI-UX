// TEMPORARY probe (F-315). Deleted before handoff. Test database only.
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '../generated/prisma/index.js';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local'), override: true });

const url = process.env.TEST_DATABASE_URL;
if (!url || !url.includes('openlovable_test')) throw new Error('need openlovable_test url');

const prisma = new PrismaClient({ datasources: { db: { url } } });

const cols = await prisma.$queryRawUnsafe(
  `select column_name, data_type from information_schema.columns where table_name = 'Workspace' and column_name in ('storageBytes','storageLimitBytes')`,
);
console.log('columns before:', JSON.stringify(cols));

const BIG = 3_000_000_000;
console.log('--- probe 1: model-API write of 3e9 with the CURRENT client');
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

console.log('--- probe 2: raw write of 3e9, then model-API read');
await prisma.$executeRawUnsafe(
  `INSERT INTO "Workspace" ("id","storageBytes") VALUES ('probe_f315', 0) ON CONFLICT ("id") DO NOTHING`,
);
try {
  await prisma.$executeRawUnsafe(
    `UPDATE "Workspace" SET "storageBytes" = 3000000000 WHERE id = 'probe_f315'`,
  );
  console.log('raw write ok');
} catch (error) {
  console.log('raw write FAILED:', String(error).split('\n').slice(0, 4).join(' | '));
}
try {
  const row = await prisma.workspace.findUnique({ where: { id: 'probe_f315' } });
  console.log('model read:', row && row.storageBytes, typeof (row && row.storageBytes));
} catch (error) {
  console.log('model read FAILED:', String(error).split('\n').slice(0, 6).join(' | '));
}
try {
  const raw = await prisma.$queryRawUnsafe(
    `SELECT "storageBytes" FROM "Workspace" WHERE id = 'probe_f315'`,
  );
  console.log(
    'raw read:',
    JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
  );
} catch (error) {
  console.log('raw read FAILED:', String(error).split('\n').slice(0, 4).join(' | '));
}

await prisma.$executeRawUnsafe(`DELETE FROM "Workspace" WHERE id = 'probe_f315'`);
await prisma.$disconnect();
