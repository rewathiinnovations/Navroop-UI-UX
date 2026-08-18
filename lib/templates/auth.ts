import type { Role } from '@/generated/prisma';

export const ADMIN_TEMPLATES_FORBIDDEN = 'Admin access required';

export function canManageTemplates(role: Role | string) {
  return role === 'ADMIN';
}

export function memberCannotAdmin(): { ok: false; status: 403; error: string } {
  return { ok: false, status: 403, error: ADMIN_TEMPLATES_FORBIDDEN };
}
