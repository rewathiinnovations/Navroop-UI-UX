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
 * Two things changed after F-231/F-232:
 *  - the build is no longer awaited here. This function starts the PUBLISH job and hands
 *    back `finish`, which the server action runs in the background under the project lock.
 *  - the previous plaintext is read off the Coolify application *before* anything is
 *    written, because that env var is its only copy. A failed change now restores the hash
 *    and the env var together; restoring only the hash left the abandoned plaintext on the
 *    app, so the next successful publish would have deployed a gate accepting a password
 *    the product said was not set.
 *
 * Goes red if the env var stops being written, if the re-publish is dropped (the container
 * only picks up a new env on deploy), if clearing leaves the old password on the app, if the
 * plaintext starts travelling in the job, or if either half of the rollback is skipped.
 */

const db = vi.hoisted(() => ({
  deploymentFindUnique: vi.fn(),
  deploymentUpdate: vi.fn(),
  deploymentFindUniqueOrThrow: vi.fn(),
  projectFindFirst: vi.fn(),
  executeRaw: vi.fn(),
}));
const coolify = vi.hoisted(() => ({
  setApplicationEnvVars: vi.fn(),
  setBasicAuth: vi.fn(),
  getApplicationEnvVar: vi.fn(),
}));
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
  getApplicationEnvVar: coolify.getApplicationEnvVar,
}));
vi.mock('@/lib/coolify/servers', () => ({
  pickCoolifyServer: vi.fn(),
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
const OLD_PASSWORD = ['the', 'previous', 'one'].join('-');

function seedPreview(stack: 'NEXTJS' | 'STATIC_HTML', passwordHash: string | null = null) {
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
    passwordHash,
    server: { id: 'srv_1', apiUrl: 'https://coolify.test', apiToken: 'stub' },
    project: { stack },
  });
}

/** The row as it stood before this change: a preview that already had a password. */
function seedProtectedPreview() {
  seedPreview('NEXTJS', `hashed:${OLD_PASSWORD}`);
  coolify.getApplicationEnvVar.mockResolvedValue(OLD_PASSWORD);
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
  // No password on the application yet: the key exists with an empty value, or not at all.
  coolify.getApplicationEnvVar.mockResolvedValue(null);
  // The runner returns the settled job. Anything other than SUCCEEDED means the build
  // carrying the new gate did not land.
  execute.runPublishJob.mockResolvedValue({ id: 'job_1', status: 'SUCCEEDED' });
});

describe('updatePreviewPassword — node stack', () => {
  it('puts the plaintext on the Coolify app and starts the publish that ships the gate', async () => {
    const update = await updatePreviewPassword({
      projectId: PROJECT,
      userId: USER,
      password: PASSWORD,
    });

    expect(coolify.setApplicationEnvVars).toHaveBeenCalledWith(expect.anything(), APP_UUID, {
      PREVIEW_PASSWORD: PASSWORD,
    });
    // Only the hash is persisted, and the plaintext never rides along in the job input.
    expect(db.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: DEPLOYMENT },
      data: { passwordHash: `hashed:${PASSWORD}` },
    });
    expect(JSON.stringify(jobs.createOrReuseJob.mock.calls)).not.toContain(PASSWORD);
    expect(coolify.setBasicAuth).not.toHaveBeenCalled();
    expect(update.jobId).toBe('job_1');
  });

  it('does not run the build inline — the caller gets a job to follow (F-232)', async () => {
    // The ten-minute Coolify poll used to happen inside the request, so the action was cut
    // off by the platform timeout and reported failure for a publish still in flight.
    const update = await updatePreviewPassword({
      projectId: PROJECT,
      userId: USER,
      password: PASSWORD,
    });

    expect(execute.runPublishJob).not.toHaveBeenCalled();
    expect(update.finish).toBeTypeOf('function');

    await update.finish?.();
    expect(execute.runPublishJob).toHaveBeenCalledWith('job_1');
  });

  it('clears the env var when the password is removed', async () => {
    seedProtectedPreview();

    const update = await updatePreviewPassword({
      projectId: PROJECT,
      userId: USER,
      password: null,
    });
    await update.finish?.();

    expect(coolify.setApplicationEnvVars).toHaveBeenCalledWith(expect.anything(), APP_UUID, {
      PREVIEW_PASSWORD: '',
    });
    expect(db.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: DEPLOYMENT },
      data: { passwordHash: null },
    });
    expect(execute.runPublishJob).toHaveBeenCalledWith('job_1');
  });

  it('puts the hash and the plaintext back when the re-publish never lands', async () => {
    seedProtectedPreview();
    execute.runPublishJob.mockRejectedValue(new Error('Coolify build fail: exited'));

    const update = await updatePreviewPassword({
      projectId: PROJECT,
      userId: USER,
      password: PASSWORD,
    });
    await expect(update.finish?.()).rejects.toThrow('Coolify build fail: exited');

    // The deployed app still runs the previous middleware, so the row must not claim the new
    // password is in force — `hasPassword` is read straight off it.
    expect(db.deploymentUpdate).toHaveBeenLastCalledWith({
      where: { id: DEPLOYMENT },
      data: { passwordHash: `hashed:${OLD_PASSWORD}` },
    });
    // And the application must not be left holding a password nothing deployed: the next
    // successful publish would inject a gate from the restored hash and compare it against
    // whatever is on the app (F-231).
    expect(coolify.setApplicationEnvVars).toHaveBeenLastCalledWith(expect.anything(), APP_UUID, {
      PREVIEW_PASSWORD: OLD_PASSWORD,
    });
  });

  it('rolls back to an empty env var when there was no password before', async () => {
    execute.runPublishJob.mockRejectedValue(new Error('Coolify build fail: exited'));

    const update = await updatePreviewPassword({
      projectId: PROJECT,
      userId: USER,
      password: PASSWORD,
    });
    await expect(update.finish?.()).rejects.toThrow('Coolify build fail: exited');

    expect(db.deploymentUpdate).toHaveBeenLastCalledWith({
      where: { id: DEPLOYMENT },
      data: { passwordHash: null },
    });
    expect(coolify.setApplicationEnvVars).toHaveBeenLastCalledWith(expect.anything(), APP_UUID, {
      PREVIEW_PASSWORD: '',
    });
  });

  it('rolls back when a runner was already in flight and this one declined', async () => {
    seedProtectedPreview();
    // The `claimJobRun` guard: a second runner on an in-flight job returns the job instead
    // of executing it. That is not an error, so it has to be *read* — the middleware
    // carrying the new gate was never built either way.
    execute.runPublishJob.mockResolvedValue({ id: 'job_1', status: 'RUNNING' });

    const update = await updatePreviewPassword({
      projectId: PROJECT,
      userId: USER,
      password: PASSWORD,
    });
    await expect(update.finish?.()).rejects.toThrow(
      'A publish is already running for this project',
    );

    expect(db.deploymentUpdate).toHaveBeenLastCalledWith({
      where: { id: DEPLOYMENT },
      data: { passwordHash: `hashed:${OLD_PASSWORD}` },
    });
    expect(coolify.setApplicationEnvVars).toHaveBeenLastCalledWith(expect.anything(), APP_UUID, {
      PREVIEW_PASSWORD: OLD_PASSWORD,
    });
  });

  it('rolls back when the job cannot even be started', async () => {
    seedProtectedPreview();
    jobs.getActiveJob.mockResolvedValue({
      id: 'job_live',
      kind: 'PUBLISH',
      status: 'RUNNING',
      inputPrompt: 'LIVE',
    });

    await expect(
      updatePreviewPassword({ projectId: PROJECT, userId: USER, password: PASSWORD }),
    ).rejects.toThrow(/live publish is still running/i);

    expect(db.deploymentUpdate).toHaveBeenLastCalledWith({
      where: { id: DEPLOYMENT },
      data: { passwordHash: `hashed:${OLD_PASSWORD}` },
    });
    expect(coolify.setApplicationEnvVars).toHaveBeenLastCalledWith(expect.anything(), APP_UUID, {
      PREVIEW_PASSWORD: OLD_PASSWORD,
    });
  });

  it('writes nothing at all when the previous plaintext cannot be read', async () => {
    // Overwriting the only copy of the plaintext without holding it means a failure can
    // never be undone. Refusing before the first write keeps the row and the application
    // in agreement, and this is a Coolify the publish could not have reached anyway.
    seedProtectedPreview();
    coolify.getApplicationEnvVar.mockRejectedValue(new Error('Coolify 502 /envs'));

    await expect(
      updatePreviewPassword({ projectId: PROJECT, userId: USER, password: PASSWORD }),
    ).rejects.toThrow('Coolify 502 /envs');

    expect(db.deploymentUpdate).not.toHaveBeenCalled();
    expect(coolify.setApplicationEnvVars).not.toHaveBeenCalled();
    expect(jobs.createOrReuseJob).not.toHaveBeenCalled();
  });
});

describe('updatePreviewPassword — static stack', () => {
  it('uses Traefik basic auth and needs no env var or rebuild', async () => {
    seedPreview('STATIC_HTML');

    const update = await updatePreviewPassword({
      projectId: PROJECT,
      userId: USER,
      password: PASSWORD,
    });

    expect(coolify.setBasicAuth).toHaveBeenCalledWith(expect.anything(), APP_UUID, {
      username: 'preview',
      password: PASSWORD,
    });
    expect(coolify.setApplicationEnvVars).not.toHaveBeenCalled();
    // Nothing to read back either: the gate lives on the application, not in a build.
    expect(coolify.getApplicationEnvVar).not.toHaveBeenCalled();
    expect(execute.runPublishJob).not.toHaveBeenCalled();
    expect(update.jobId).toBeNull();
    expect(update.finish).toBeNull();
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
