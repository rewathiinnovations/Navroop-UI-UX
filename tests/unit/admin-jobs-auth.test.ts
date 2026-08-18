import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Admin job routes must distinguish "no session" (401) from "signed in but
 * not ADMIN" (403). The proxy already answers 401 in production; these
 * handlers are defence in depth and used to lie with 403 for a missing session.
 */

const requireAdmin = vi.hoisted(() => vi.fn());
const jobsAdmin = vi.hoisted(() => ({
  getJobsAdmin: vi.fn(),
  adminAbandonJob: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAdmin,
}));

vi.mock('@/lib/jobs/admin', () => jobsAdmin);

vi.mock('@/lib/audit/log', () => ({
  writeAudit: vi.fn(),
}));

function request(path: string, method: string) {
  return new NextRequest(`http://localhost:3000${path}`, { method });
}

describe('admin job routes: 401 vs 403', () => {
  beforeEach(() => {
    requireAdmin.mockReset();
    jobsAdmin.getJobsAdmin.mockReset();
    jobsAdmin.adminAbandonJob.mockReset();
    jobsAdmin.getJobsAdmin.mockResolvedValue({ active: [], failedByErrorCode: {}, abandonmentsPerDay: [] });
    jobsAdmin.adminAbandonJob.mockResolvedValue({ ok: true, job: null });
  });

  it('POST abandon answers 401 when there is no session, not 403', async () => {
    requireAdmin.mockResolvedValue({ user: null, error: 'Sign in required', status: 401 });
    const { POST } = await import('@/app/api/admin/jobs/[id]/abandon/route');
    const response = await POST(request('/api/admin/jobs/j-1/abandon', 'POST'), {
      params: Promise.resolve({ id: 'j-1' }),
    });
    expect(response.status).toBe(401);
    expect(jobsAdmin.adminAbandonJob).not.toHaveBeenCalled();
  });

  it('POST abandon still answers 403 for a signed-in member', async () => {
    requireAdmin.mockResolvedValue({ user: null, error: 'Admin access required', status: 403 });
    const { POST } = await import('@/app/api/admin/jobs/[id]/abandon/route');
    const response = await POST(request('/api/admin/jobs/j-1/abandon', 'POST'), {
      params: Promise.resolve({ id: 'j-1' }),
    });
    expect(response.status).toBe(403);
    expect(jobsAdmin.adminAbandonJob).not.toHaveBeenCalled();
  });

  it('GET /api/admin/jobs answers 401 when there is no session, not 403', async () => {
    requireAdmin.mockResolvedValue({ user: null, error: 'Sign in required', status: 401 });
    const { GET } = await import('@/app/api/admin/jobs/route');
    const response = await GET();
    expect(response.status).toBe(401);
    expect(jobsAdmin.getJobsAdmin).not.toHaveBeenCalled();
  });

  it('GET /api/admin/jobs still answers 403 for a signed-in member', async () => {
    requireAdmin.mockResolvedValue({ user: null, error: 'Admin access required', status: 403 });
    const { GET } = await import('@/app/api/admin/jobs/route');
    const response = await GET();
    expect(response.status).toBe(403);
    expect(jobsAdmin.getJobsAdmin).not.toHaveBeenCalled();
  });
});
