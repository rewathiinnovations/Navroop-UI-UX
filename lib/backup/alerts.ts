import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/client';
import { backupFailedEmail } from '@/lib/email/templates/backup-failed';
import { STALE_BACKUP_BANNER } from './copy';

export const BACKUP_ALERT_KEY = 'backup.alert';

export type BackupAlertKind = 'failed' | 'stale' | 'restore_test';

export type BackupAlert = {
  at: string;
  kind: BackupAlertKind;
  message: string;
};

export async function notifyBackupAlert(kind: BackupAlertKind, message: string) {
  const value: BackupAlert = { at: new Date().toISOString(), kind, message };
  await prisma.appSetting.upsert({
    where: { key: BACKUP_ALERT_KEY },
    create: { key: BACKUP_ALERT_KEY, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  });

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, email: true },
  });
  console.info('[backup] admin alert', {
    kind,
    adminCount: admins.length,
    adminIds: admins.map((admin) => admin.id),
  });

  const email = backupFailedEmail({ message });
  for (const admin of admins) {
    await sendEmail({ to: admin.email, ...email });
  }
}

/**
 * Clearing an alert that was never raised is the normal case, so this uses `deleteMany`
 * instead of `delete` rather than swallowing the not-found error along with everything
 * else. A real failure leaves a stale "backups are failing" banner on `/admin/backups`, so
 * it is logged and reported, not hidden — but it never fails the backup that just
 * succeeded.
 */
export async function clearBackupAlert() {
  try {
    await prisma.appSetting.deleteMany({ where: { key: BACKUP_ALERT_KEY } });
    return { cleared: true as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[backup] could not clear the backup alert', {
      message: 'The stale-backup banner will stay up until this clears.',
      error: message,
    });
    return { cleared: false as const, error: message };
  }
}

export async function getBackupAlert(): Promise<BackupAlert | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: BACKUP_ALERT_KEY } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as BackupAlert;
  } catch {
    return null;
  }
}

export async function notifyStaleBackupIfNeeded(stale: boolean) {
  if (!stale) return;
  await notifyBackupAlert('stale', STALE_BACKUP_BANNER);
}
