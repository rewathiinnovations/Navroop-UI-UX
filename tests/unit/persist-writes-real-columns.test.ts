/**
 * The generation persist may only write columns `Project` actually has.
 *
 * `20260819010000_drop_sandbox_columns` removed `Project.sandboxId`, but the whole
 * persist chain kept carrying it: the client sent `sandboxId: null` (present, not
 * absent), `readGenerationInput` parsed it, and `persistProjectGeneration` spread it
 * into `prisma.project.update`. Prisma answered
 * `PrismaClientValidationError: Unknown argument 'sandboxId'`, the PATCH became a
 * 500, and the client's stream reader died on the FIRST progress frame — so a build
 * that streamed 96k output tokens over eleven minutes showed an empty pane and
 * "Building your project…" the whole time, then lost its files.
 *
 * These cases fail if any dropped column comes back into the payload or the update.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DROPPED_COLUMNS = [
  'sandboxId',
  'sandboxStatus',
  'sandboxStartedAt',
  'sandboxLastUsedAt',
  'sandboxProviderConfigId',
];

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  executeRaw: vi.fn(async () => 1),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
    $executeRaw: db.executeRaw,
  },
}));

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  getSessionUser: auth.getSessionUser,
  canMutate: (user: { id: string; role: string }, ownerId: string) =>
    user.id === ownerId || user.role === 'ADMIN',
}));

const checkpoints = vi.hoisted(() => ({
  createCheckpointAfterGeneration: vi.fn(async () => null),
}));
vi.mock('@/lib/checkpoints/actions', () => ({
  createCheckpointAfterGeneration: checkpoints.createCheckpointAfterGeneration,
}));
vi.mock('@/lib/preview/production', () => ({
  capturePreviewAfterGeneration: vi.fn(async () => null),
}));
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => null,
  applyCreateProjectPlanFlow: vi.fn(),
}));

// Dynamic so every vi.mock above registers before the module graph is evaluated.
const { persistProjectGeneration } = await import('@/lib/projects/actions');
const { readGenerationInput, hasGenerationFields } = await import('@/lib/projects/http');

const OWNER = { id: 'owner-1', role: 'MEMBER' };
const PROJECT = 'proj_persist';

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue(OWNER);
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, phase: 'BUILDING', ownerId: OWNER.id });
  db.projectUpdate.mockResolvedValue({ id: PROJECT, owner: OWNER });
});

describe('the generation persist writes only real Project columns', () => {
  it('does not send a dropped column even when the client asks for one', async () => {
    // The exact shape the workspace used to send: a null sandboxId alongside real fields.
    await persistProjectGeneration(PROJECT, {
      previewUrl: null,
      progressMessage: 'Generating app/page.tsx',
      generationStatus: 'generating',
      ...({ sandboxId: null } as Record<string, never>),
    });

    expect(db.projectUpdate).toHaveBeenCalledTimes(1);
    const data = db.projectUpdate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    for (const column of DROPPED_COLUMNS) {
      expect(data).not.toHaveProperty(column);
    }
    expect(data).toMatchObject({ progressMessage: 'Generating app/page.tsx' });
  });

  it('still writes the fields that do exist', async () => {
    await persistProjectGeneration(PROJECT, {
      previewUrl: 'https://preview.example/p',
      lastCode: '<file path="app/page.tsx">x</file>',
      generationStatus: 'ready',
    });

    const data = db.projectUpdate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.previewUrl).toBe('https://preview.example/p');
    expect(data.lastCode).toBe('<file path="app/page.tsx">x</file>');
    // Site evidence plus a ready status promotes the phase.
    expect(data.phase).toBe('COMPLETE');
  });

  it('does not turn a checkpoint that had nothing to save into a failure', async () => {
    // An answer turn ("hello") ends with the same terminal ready PATCH as a build.
    // `createCheckpointAfterGeneration` answers null when there is nothing to
    // snapshot — it used to throw, and the caller caught and logged it, putting an
    // error line in the log for an entirely normal chat message.
    checkpoints.createCheckpointAfterGeneration.mockResolvedValue(null);

    const result = await persistProjectGeneration(PROJECT, { generationStatus: 'ready' });

    expect(result.ok).toBe(true);
  });
});

describe('the request parser does not carry dropped columns', () => {
  it('drops them from the parsed input', () => {
    const parsed = readGenerationInput({
      progressMessage: 'x',
      sandboxId: 'sbx_1',
      sandboxStatus: 'READY',
    }) as Record<string, unknown>;

    for (const column of DROPPED_COLUMNS) {
      expect(parsed).not.toHaveProperty(column);
    }
  });

  it('does not treat a dropped column as a reason to run the generation persist', () => {
    // A body carrying only a dead field must not look like a generation update, or
    // the route would run the persist for a request with nothing real in it.
    const parsed = readGenerationInput({ sandboxId: 'sbx_1' });
    expect(hasGenerationFields(parsed)).toBe(false);

    expect(hasGenerationFields(readGenerationInput({ progressMessage: 'x' }))).toBe(true);
  });
});
