import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `startPublishJob` is allowed to hand back when a publish is already running.
 *
 * The short-circuit only asked whether the active job was a PUBLISH; it never compared
 * the running kind (carried in `Job.inputPrompt`) with the requested one. Clicking
 * "Go live" while a preview publish was still building therefore returned the PREVIEW
 * job id, the caller ran that job again, and the live publish never started — the user
 * watched a progress bar to completion and got no live site. Worse, the deployment id
 * fell back to `active.id`, i.e. a job id in the slot a Deployment id belongs in
 * (F-239).
 *
 * Goes red if the kinds stop being compared, or if a job id is ever returned as a
 * deployment id again.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  deploymentFindUnique: vi.fn(),
  deploymentCreate: vi.fn(),
  deploymentUpdate: vi.fn(),
  executeRaw: vi.fn(),
}));
const jobs = vi.hoisted(() => ({ createOrReuseJob: vi.fn(), getActiveJob: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst },
    deployment: {
      findUnique: db.deploymentFindUnique,
      create: db.deploymentCreate,
      update: db.deploymentUpdate,
    },
    $executeRaw: db.executeRaw,
  },
}));
vi.mock('@/lib/coolify/client', () => ({
  setApplicationEnvVars: vi.fn(),
  setBasicAuth: vi.fn(),
  readApplicationEnvVar: vi.fn(),
}));
vi.mock('@/lib/coolify/servers', () => ({
  pickCoolifyServer: vi.fn(async () => ({ id: 'srv_1' })),
  serverAuth: () => ({ apiUrl: 'https://coolify.test', apiToken: 'stub' }),
}));
vi.mock('@/lib/integrations/store', () => ({
  getPublishReadiness: async () => ({ missing: [], unreadable: [] }),
}));
vi.mock('@/lib/jobs', () => ({
  createOrReuseJob: jobs.createOrReuseJob,
  getActiveJob: jobs.getActiveJob,
}));
vi.mock('@/lib/publish/limits', () => ({
  assertPublishSlot: vi.fn(),
  PublishLimitError: class extends Error {},
}));
vi.mock('@/lib/publish/execute', () => ({ runPublishJob: vi.fn() }));
vi.mock('@/lib/observability/track', () => ({ trackStart: vi.fn() }));
vi.mock('@/lib/storage/usage', () => ({ WORKSPACE_ROW_ID: 'default' }));
vi.mock('@/lib/password', () => ({ hashPassword: async (value: string) => `hashed:${value}` }));

// Dynamic on purpose: publish.ts pulls Coolify, the job store and the publish loop at
// import time, so the module may only be evaluated once the factories above exist.
const { startPublishJob } = await import('@/lib/publish/publish');

const PROJECT = 'proj_1';
const USER = 'user_1';

beforeEach(() => {
  vi.clearAllMocks();
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, name: 'Shop', stack: 'NEXTJS' });
  db.deploymentFindUnique.mockResolvedValue(null);
  db.deploymentCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'dep_new',
    ...data,
    publishedAt: null,
  }));
  db.deploymentUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'dep_existing',
    ...data,
    publishedAt: null,
  }));
  db.executeRaw.mockResolvedValue(1);
  jobs.createOrReuseJob.mockResolvedValue({ id: 'job_new' });
  jobs.getActiveJob.mockResolvedValue(null);
});

describe('startPublishJob with another publish in flight', () => {
  it('refuses a LIVE publish while a PREVIEW publish is running', async () => {
    jobs.getActiveJob.mockResolvedValue({
      id: 'job_preview',
      kind: 'PUBLISH',
      status: 'RUNNING',
      inputPrompt: 'PREVIEW',
    });

    await expect(
      startPublishJob({ projectId: PROJECT, kind: 'LIVE', userId: USER }),
    ).rejects.toThrow(/preview publish is still running/i);
    // Nothing may be created for the kind that was refused.
    expect(jobs.createOrReuseJob).not.toHaveBeenCalled();
    expect(db.deploymentCreate).not.toHaveBeenCalled();
  });

  it('refuses a PREVIEW publish while a LIVE publish is running', async () => {
    jobs.getActiveJob.mockResolvedValue({
      id: 'job_live',
      kind: 'PUBLISH',
      status: 'QUEUED',
      inputPrompt: 'LIVE',
    });

    await expect(
      startPublishJob({ projectId: PROJECT, kind: 'PREVIEW', userId: USER }),
    ).rejects.toThrow(/live publish is still running/i);
  });

  it('re-joins the in-flight job of the same kind, and never passes a job id off as a deployment id', async () => {
    jobs.getActiveJob.mockResolvedValue({
      id: 'job_preview',
      kind: 'PUBLISH',
      status: 'RUNNING',
      inputPrompt: 'PREVIEW',
    });

    const rejoined = await startPublishJob({ projectId: PROJECT, kind: 'PREVIEW', userId: USER });

    expect(rejoined.jobId).toBe('job_preview');
    // There is no Deployment row for this kind yet: null says so. `active.id` was a
    // type-correct wrong answer any caller would misuse.
    expect(rejoined.deploymentId).toBeNull();
  });

  it('re-joining reports the real deployment id when one exists', async () => {
    jobs.getActiveJob.mockResolvedValue({
      id: 'job_live',
      kind: 'PUBLISH',
      status: 'RUNNING',
      inputPrompt: 'LIVE',
    });
    db.deploymentFindUnique.mockResolvedValue({ id: 'dep_live', kind: 'LIVE' });

    const rejoined = await startPublishJob({ projectId: PROJECT, kind: 'LIVE', userId: USER });

    expect(rejoined).toEqual({ jobId: 'job_live', deploymentId: 'dep_live' });
  });

  it('still refuses when a generation is running', async () => {
    jobs.getActiveJob.mockResolvedValue({
      id: 'job_gen',
      kind: 'BUILD',
      status: 'RUNNING',
      inputPrompt: 'make it blue',
    });

    await expect(
      startPublishJob({ projectId: PROJECT, kind: 'LIVE', userId: USER }),
    ).rejects.toThrow('Wait for the current build to finish');
  });
});
