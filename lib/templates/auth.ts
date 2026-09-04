import type { Role } from '@/generated/prisma';
import { isVisibleToWorkspace } from './visibility';

export const ADMIN_TEMPLATES_FORBIDDEN = 'Admin access required';
export const BUILTIN_TEMPLATE_DELETE_FORBIDDEN = 'Only an admin can delete a built-in template.';
export const WORKSPACE_TEMPLATE_DELETE_FORBIDDEN = 'You can only delete a template you saved.';

export function canManageTemplates(role: Role | string) {
  return role === 'ADMIN';
}

export function memberCannotAdmin(): { ok: false; status: 403; error: string } {
  return { ok: false, status: 403, error: ADMIN_TEMPLATES_FORBIDDEN };
}

/** Shared (workspaceId null) or flagged built-in — ADMIN-only to delete. */
export function isBuiltInTemplate(row: { isBuiltIn: boolean; workspaceId: string | null }) {
  return row.isBuiltIn || row.workspaceId == null;
}

/**
 * Owner/ADMIN for a workspace-owned row; ADMIN for a built-in.
 * Another workspace is never deletable here — callers 404 so the row does not leak.
 */
export function canDeleteTemplate(
  user: { id: string; role: Role | string },
  row: {
    isBuiltIn: boolean;
    workspaceId: string | null;
    createdById: string | null;
    isActive?: boolean;
  },
  workspaceId = 'default',
): boolean {
  if (
    !isVisibleToWorkspace(
      { workspaceId: row.workspaceId, isActive: row.isActive !== false },
      workspaceId,
      { includeInactive: canManageTemplates(user.role) },
    )
  ) {
    return false;
  }
  if (isBuiltInTemplate(row)) return canManageTemplates(user.role);
  return canManageTemplates(user.role) || row.createdById === user.id;
}
