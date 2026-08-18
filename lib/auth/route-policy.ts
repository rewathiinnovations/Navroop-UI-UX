/**
 * Authorization contract for mutating API routes.
 * Auth-matrix tests fail if a listed file no longer calls the required gate.
 *
 * Navroop is a single-workspace product (`Workspace.id = default`).
 * "Different workspace" in the matrix means a member who does not own the
 * target project (and is not ADMIN).
 */

export type ActorRole = 'anonymous' | 'member' | 'member_deactivated' | 'admin' | 'other_member';

export type RoutePolicy = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  file: string;
  /** File that must contain the gate (defaults to `file`). */
  gateFile?: string;
  /** Source must contain this gate (or a stronger one). */
  gate: 'requireAdmin' | 'requireSessionUser' | 'getSessionUser' | 'public';
  allow: ActorRole[];
};

export const MUTATING_ROUTE_POLICIES: RoutePolicy[] = [
  {
    method: 'POST',
    path: '/api/admin/invite',
    file: 'app/api/admin/invite/route.ts',
    gate: 'requireAdmin',
    allow: ['admin'],
  },
  {
    method: 'PATCH',
    path: '/api/admin/workspace',
    file: 'app/api/admin/workspace/route.ts',
    gate: 'requireAdmin',
    allow: ['admin'],
  },
  {
    method: 'POST',
    path: '/api/admin/plans',
    file: 'app/api/admin/plans/route.ts',
    gate: 'requireAdmin',
    allow: ['admin'],
  },
  {
    method: 'POST',
    path: '/api/admin/jobs/[id]/abandon',
    file: 'app/api/admin/jobs/[id]/abandon/route.ts',
    gate: 'requireAdmin',
    allow: ['admin'],
  },
  {
    method: 'POST',
    path: '/api/projects',
    file: 'app/api/projects/route.ts',
    gateFile: 'lib/projects/actions.ts',
    gate: 'getSessionUser',
    allow: ['member', 'admin'],
  },
  {
    method: 'DELETE',
    path: '/api/projects/[id]',
    file: 'app/api/projects/[id]/route.ts',
    gateFile: 'lib/projects/actions.ts',
    gate: 'getSessionUser',
    allow: ['member', 'admin'],
  },
  {
    method: 'POST',
    path: '/api/projects/[id]/publish',
    file: 'app/api/projects/[id]/publish/route.ts',
    gate: 'getSessionUser',
    allow: ['member', 'admin'],
  },
  {
    method: 'POST',
    path: '/api/projects/[id]/import',
    file: 'app/api/projects/[id]/import/route.ts',
    gate: 'getSessionUser',
    allow: ['member', 'admin'],
  },
  {
    method: 'POST',
    path: '/api/projects/[id]/plan/approve',
    file: 'app/api/projects/[id]/plan/approve/route.ts',
    gateFile: 'lib/projects/plan.ts',
    gate: 'getSessionUser',
    allow: ['member', 'admin'],
  },
  {
    method: 'POST',
    path: '/api/auth/forgot-password',
    file: 'app/api/auth/forgot-password/route.ts',
    gate: 'public',
    allow: ['anonymous', 'member', 'admin', 'other_member', 'member_deactivated'],
  },
];

export function gatePattern(gate: RoutePolicy['gate']) {
  if (gate === 'public') return null;
  if (gate === 'requireAdmin') return /requireAdmin\s*\(/;
  if (gate === 'requireSessionUser') return /requireSessionUser\s*\(|requireAdmin\s*\(/;
  return /getSessionUser\s*\(|requireSessionUser\s*\(|requireAdmin\s*\(/;
}
