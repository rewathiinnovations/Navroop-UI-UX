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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { persistProject } = await import('@/lib/projects/persist-client');

const OWNER = { id: 'owner-1', role: 'MEMBER' };
const PROJECT = 'proj_persist';

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue(OWNER);
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, phase: 'BUILDING', ownerId: OWNER.id });
  db.projectUpdate.mockResolvedValue({ id: PROJECT, owner: OWNER });
});

afterEach(() => {
  vi.unstubAllGlobals();
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
  /**
   * `readGenerationInput` now answers `{ ok, data }` so a bad field is a 400
   * naming it rather than a Prisma exception (F-743). Every assertion here has
   * to reach through that envelope: read off the envelope itself and a
   * `not.toHaveProperty` — or a `hasGenerationFields` — is true of anything at
   * all, which is how the negative case below used to pass without testing
   * anything.
   */
  const parsedData = (body: Record<string, unknown>) => {
    const result = readGenerationInput(body);
    if (!result.ok) throw new Error(`expected a parse, got ${result.error}`);
    return result.data;
  };

  it('drops them from the parsed input', () => {
    const data = parsedData({
      progressMessage: 'x',
      sandboxId: 'sbx_1',
      sandboxStatus: 'READY',
    }) as Record<string, unknown>;

    expect(data).toHaveProperty('progressMessage');
    for (const column of DROPPED_COLUMNS) {
      expect(data).not.toHaveProperty(column);
    }
  });

  it('does not treat a dropped column as a reason to run the generation persist', () => {
    // A body carrying only a dead field must not look like a generation update, or
    // the route would run the persist for a request with nothing real in it.
    expect(hasGenerationFields(parsedData({ sandboxId: 'sbx_1' }))).toBe(false);
    expect(hasGenerationFields(parsedData({ progressMessage: 'x' }))).toBe(true);
  });

  it('refuses a non-string lastCode with a 400 rather than a Prisma exception', () => {
    const result = readGenerationInput({ lastCode: { a: 1 } });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toContain('lastCode');
  });
});

/**
 * The browser is not the writer of generation progress.
 *
 * `saveCurrentProject` used to put `status` and `progressMessage` into every save,
 * so the client was a second writer of `Project.generationStatus` — a column the
 * job lifecycle owns — and the only writer of `progressMessage`, which nothing
 * renders. The authoritative progress is on the Job row (`createProgressBatcher`
 * plus the heartbeat) and the workspace already polls it back through
 * `GET /api/projects/{id}/job`. The failure that made it worth removing: a tab
 * closed mid-build leaves `generating` on the project with nobody to correct it.
 *
 * The casts below are the shape the old callers sent, so this case fails against
 * the old client rather than merely describing the new one.
 */
describe('the client save does not report generation progress', () => {
  function captureBody() {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ project: { id: PROJECT, name: 'Site' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    return sent;
  }

  it('sends neither status nor progressMessage, however the caller asks', async () => {
    const sent = captureBody();
    // A variable, not an inline literal: excess-property checking would refuse the
    // two dead fields at the call site, and the point is what happens at runtime
    // when they are handed over anyway.
    const legacyInput = {
      prompt: 'https://example.com',
      title: 'Site',
      status: 'generating',
      progressMessage: 'Generating code...',
    };

    await persistProject(legacyInput);

    expect(sent).toHaveLength(1);
    for (const field of ['status', 'generationStatus', 'progressMessage']) {
      expect(sent[0]?.body).not.toHaveProperty(field);
    }
  });

  it('still creates the project, which is the whole reason it runs', async () => {
    const sent = captureBody();

    const result = await persistProject({ prompt: 'https://example.com', title: 'Site' });

    expect(sent[0]?.url).toBe('/api/projects');
    expect(sent[0]?.body).toMatchObject({ initialPrompt: 'https://example.com', name: 'Site' });
    expect(result.saved).toBe(true);
    // The id the URL import and the router.replace onto /project/{id} both need.
    if (result.saved) expect(result.project.id).toBe(PROJECT);
  });
});
