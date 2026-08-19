'use server';

import { unstable_update } from '@/auth';
import { prisma } from '@/lib/db';
import { hashPassword, requireSessionUser, toPublicUser, verifyPassword } from '@/lib/auth';
import { passwordChangeWrites } from '@/lib/auth/session-invalidation';
import { sendEmail } from '@/lib/email/client';
import { passwordChangedEmail } from '@/lib/email/templates/password-changed';
import {
  changePasswordSchema,
  parseWithZod,
  updateProfileSchema,
  type UpdateProfileInput,
} from '@/lib/profile/schema';
import { avatarStorageKey } from '@/lib/assets/keys';
import { optimizeImage } from '@/lib/assets/optimize';
import { upload } from '@/lib/storage';

export type ActionOk<T> = { ok: true; data: T };
export type ActionErr = {
  ok: false;
  error: string;
  status: number;
  details?: unknown;
};
export type ActionResult<T> = ActionOk<T> | ActionErr;

const WRONG_CURRENT_PASSWORD = 'Current password is incorrect';

export async function updateProfile(input: UpdateProfileInput) {
  const { user, error, status } = await requireSessionUser();
  if (!user) return { ok: false as const, error, status };

  const parsed = parseWithZod(updateProfileSchema, input);
  if (!parsed.ok) return parsed;

  const data: { name?: string; avatarUrl?: string | null } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (input.avatarUrl !== undefined) data.avatarUrl = parsed.data.avatarUrl;

  const updated = await prisma.user.update({
    where: { id: user.id },
    data,
    select: { id: true, email: true, name: true, role: true, avatarUrl: true },
  });

  try {
    await unstable_update({
      user: {
        name: updated.name,
        avatarUrl: updated.avatarUrl,
      },
    });
  } catch {
    // Client session.update still applies the JWT name/avatar.
  }

  return { ok: true as const, data: toPublicUser(updated) };
}

export async function uploadAvatar(formData: FormData) {
  const { user, error, status } = await requireSessionUser();
  if (!user) return { ok: false as const, error, status };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false as const, error: 'Choose an image to upload', status: 400 as const };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const optimized = await optimizeImage(buffer, { width: 512, height: 512 });
  const key = avatarStorageKey(user.id, optimized.ext);
  const stored = await upload(optimized.buffer, {
    key,
    contentType: optimized.contentType,
  });

  return updateProfile({ avatarUrl: stored.url });
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const { user, error, status } = await requireSessionUser();
  if (!user) return { ok: false as const, error, status };

  const parsed = parseWithZod(changePasswordSchema, { currentPassword, newPassword });
  if (!parsed.ok) return parsed;

  const record = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!record || !(await verifyPassword(parsed.data.currentPassword, record.passwordHash))) {
    return { ok: false as const, error: WRONG_CURRENT_PASSWORD, status: 400 as const };
  }

  await prisma.$transaction(
    passwordChangeWrites(user.id, await hashPassword(parsed.data.newPassword), new Date()),
  );

  // Same courtesy as the reset path: the account holder hears about it even if the change
  // was not theirs. Only the transport error is logged, never the password or the hash.
  const sent = await sendEmail({ to: user.email, ...passwordChangedEmail() });
  if ('ok' in sent && sent.ok === false) {
    console.error('[profile] passwordChanged email failed:', sent.error);
  }

  // Every other session is now dead, and so is the caller's own JWT — it was minted before
  // the stamp. The client has the new password in hand and re-signs in on the spot
  // (app/(app)/settings/profile/page.tsx); this flag is what tells it to.
  return { ok: true as const, data: { success: true, reauthenticate: true } };
}
