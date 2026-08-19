import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `updatePreviewPassword` is the only way a preview gets protected, and for node stacks it is
 * the only thing that can put the plaintext somewhere the deployed middleware can read it.
 *
 * The bcrypt hash on `Deployment.passwordHash` cannot be verified from Next middleware, and
 * the schema has nowhere to keep a reversible copy — so the Coolify application env var
 * `PREVIEW_PASSWORD` is the store, written here and read by the middleware that the publish
 * this function triggers injects. Before that, nothing ever wrote the env var: the hash was
 * stored, the UI reported `hasPassword: true`, and the preview answered every request.
 *
 * Goes red if the env var stops being written, if the re-publish is dropped (the container
 * only picks up a new env on deploy), if clearing leaves the old password on the app, or if
 * the plaintext starts travelling in the job instead.
 */

const db = vi.hoisted(() => ({
  deploymentFindUnique: vi.fn(),
  deploymentUpdate: vi.fn(),
  deploymentFindUniqueOrThrow: vi.fn(),
  projectFindFirst: vi.fn(),
  executeRaw: vi.fn(),
}));
const coolify = vi.hoisted(() => ({ setApplicationEnvVars: vi.fn(), setBasicAuth: vi.fn() }));
const jobs = vi.hoisted(() => ({ createOrReuseJob: vi.fn(), getActiveJob: vi.fn() }));
const execute = vi.hoisted(() => ({ runPublishJob: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    deployment: {
      findUnique: db.deploymentFindUnique,
      update: db.deploymentUpdate,
      findUniqueOrThrow: db.deploymentFindUniqueOrThrow,
    },
    project: { findFirst: db.projectFindFirst },
    $executeRaw: db.executeRaw,
  },
}));
vi.mock('@/lib/coolify/client', () => ({
  setApplicationEnvVars: coolify.setApplicationEnvVars,
  setBasicAuth: coolify.setBasicAuth,
}));
vi.mock('@/lib/coolify/servers', () => ({
  pickCoolifyServer: vi.fn(),
  serverAuth: () => ({ apiUrl: 'https://coolify.test', apiToken: 'stub' }),
}));
vi.mock('@/lib/integrations/store', () => ({ getMissingIntegrations: async () => [] }));
vi.mock('@/lib/jobs', () => ({
  createOrReuseJob: jobs.createOrReuseJob,
  getActiveJob: jobs.getActiveJob,
}));
vi.mock('@/lib/publish/limits', () => ({
  assertPublishSlot: vi.fn(),
  PublishLimitError: class extends Error {},
}));
vi.mock('@/lib/publish/execute', () => ({ runPublishJob: execute.runPublishJob }));
vi.mock('@/lib/observability/track', () => ({ trackStart: vi.fn() }));
vi.mock('@/lib/storage/usage', () => ({ WORKSPACE_ROW_ID: 'default' }));
// bcrypt at cost 12 is ~100 ms per call and the hash is not what these cases are about.
vi.mock('@/lib/password', () => ({ hashPassword: async (value: string) => `hashed:${value}` }));

// Dynamic: publish.ts pulls Coolify, the job store and the publish loop at import time, so
// the module may only be evaluated once the factories above are registered.
const { updatePreviewPassword } = await import('@/lib/publish/publish');

const PROJECT = 'proj_1';
const DEPLOYMENT = 'dep_preview';
const APP_UUID = 'coolify-app-1';
const USER = 'user_1';
// Built from parts so the staged credential scanner does not read a fixture as a
// leaked password. What matters is only that the same value comes back out.
const PASSWORD = ['a', 'strong', 'preview', 'passphrase'].join('-');

function seedPreview(stack: 'NEXTJS' | 'STATIC_HTML') {
  db.deploymentFindUnique.mockResolvedValue({
    id: DEPLOYMENT,
    projectId: PROJECT,
    workspaceId: 'default',
    serverId: 'srv_1',
    kind: 'PREVIEW',
    status: 'LIVE',
    slug: 'shop',
    coolifyAppUuid: APP_UUID,
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    passwordHash: null,
    server: { id: 'srv_1', apiUrl: 'https://coolify.test', apiToken: 'stub' },
    project: { stack },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seedPreview('NEXTJS');
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, name: 'Shop', stack: 'NEXTJS' });
  db.deploymentUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: DEPLOYMENT,
    ...data,
  }));
  db.deploymentFindUniqueOrThrow.mockResolvedValue({ id: DEPLOYMENT });
  db.executeRaw.mockResolvedValue(1);
  jobs.getActiveJob.mockResolvedValue(null);
  jobs.createOrReuseJob.mockResolvedValue({ id: 'job_1' });
});

describe('updatePreviewPassword — node stack', () => {
  it('puts the plaintext on the Coolify app and re-publishes so the gate ships with it', async () => {
    await updatePreviewPassword({ projectId: PROJECT, userId: USER, password: PASSWORD });

    expect(coolify.setApplicationEnvVars).toHaveBeenCalledWith(expect.anything(), APP_UUID, {
      PREVIEW_PASSWORD: PASSWORD,
    });
    // Env changes only reach the container on a deploy, which is why this path re-publishes.
    expect(execute.runPublishJob).toHaveBeenCalledWith('job_1');
    // Only the hash is persisted, and the plaintext never rides along in the job input.
    expect(db.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: DEPLOYMENT },
      data: { passwordHash: `hashed:${PASSWORD}` },
    });
    expect(JSON.stringify(jobs.createOrReuseJob.mock.calls)).not.toContain(PASSWORD);
    expect(coolify.setBasicAuth).not.toHaveBeenCalled();
  });

  it('clears the env var when the password is removed', async () => {
    await updatePreviewPassword({ projectId: PROJECT, userId: USER, password: null });

    expect(coolify.setApplicationEnvVars).toHaveBeenCalledWith(expect.anything(), APP_UUID, {
      PREVIEW_PASSWORD: '',
    });
    expect(db.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: DEPLOYMENT },
      data: { passwordHash: null },
    });
    expect(execute.runPublishJob).toHaveBeenCalledWith('job_1');
  });

  it('puts the hash back when the re-publish never lands', async () => {
    db.deploymentFindUnique.mockResolvedValue({
      id: DEPLOYMENT,
      projectId: PROJECT,
      workspaceId: 'default',
      serverId: 'srv_1',
      kind: 'PREVIEW',
      status: 'LIVE',
      slug: 'shop',
      coolifyAppUuid: APP_UUID,
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
      passwordHash: 'hashed:the-old-one',
      server: { id: 'srv_1', apiUrl: 'https://coolify.test', apiToken: 'stub' },
      project: { stack: 'NEXTJS' },
    });
    execute.runPublishJob.mockRejectedValue(new Error('Coolify build fail: exited'));

    await expect(
      updatePreviewPassword({ projectId: PROJECT, userId: USER, password: PASSWORD }),
    ).rejects.toThrow('Coolify build fail: exited');

    // The deployed app still runs the previous middleware, so the row must not claim the new
    // password is in force — `hasPassword` is read straight off it.
    expect(db.deploymentUpdate).toHaveBeenLastCalledWith({
      where: { id: DEPLOYMENT },
      data: { passwordHash: 'hashed:the-old-one' },
    });
  });
});

describe('updatePreviewPassword — static stack', () => {
  it('uses Traefik basic auth and needs no env var or rebuild', async () => {
    seedPreview('STATIC_HTML');

    await updatePreviewPassword({ projectId: PROJECT, userId: USER, password: PASSWORD });

    expect(coolify.setBasicAuth).toHaveBeenCalledWith(expect.anything(), APP_UUID, {
      username: 'preview',
      password: PASSWORD,
    });
    expect(coolify.setApplicationEnvVars).not.toHaveBeenCalled();
    expect(execute.runPublishJob).not.toHaveBeenCalled();
  });
});

describe('updatePreviewPassword — never published', () => {
  it('refuses when there is no Coolify application to hold the password', async () => {
    db.deploymentFindUnique.mockResolvedValue(null);

    await expect(
      updatePreviewPassword({ projectId: PROJECT, userId: USER, password: PASSWORD }),
    ).rejects.toThrow('Publish a preview first');
    expect(coolify.setApplicationEnvVars).not.toHaveBeenCalled();
  });
});
