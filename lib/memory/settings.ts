import { prisma } from '@/lib/db';
import { MEMORY_EXTRACTION_SETTING_KEY } from './types';

function parseEnabled(value: string | null | undefined) {
  if (value == null) return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'false' || normalized === '0' || normalized === 'off') return false;
  return true;
}

export async function getMemoryExtractionEnabled() {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: MEMORY_EXTRACTION_SETTING_KEY },
      select: { value: true },
    });
    return parseEnabled(row?.value);
  } catch (error) {
    console.warn('[memory] failed to read extraction setting', error);
    return true;
  }
}

export async function setMemoryExtractionEnabled(enabled: boolean) {
  await prisma.appSetting.upsert({
    where: { key: MEMORY_EXTRACTION_SETTING_KEY },
    create: { key: MEMORY_EXTRACTION_SETTING_KEY, value: enabled ? 'true' : 'false' },
    update: { value: enabled ? 'true' : 'false' },
  });
  return enabled;
}
