import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The project write path that resolved an actor and then never compared it to the
 * owner, plus the read contract of the preview route.
 *
 * `persistProjectGeneration` is reachable as `PATCH /api/projects/[id]` whenever
 * the body carries generation fields. It selected `{ id, phase }` — no `ownerId`
 * — so `const user` was dead and any signed-in member could replace another
 * member's `lastCode` (what the preview renders from), repoint `previewUrl`,
 * force `phase: COMPLETE`, and kick off a billable preview build. Its four
 * siblings in the same file all call `canMutate` two lines after the identical
 * lookup. That gate stays.
 *
 * `POST /api/projects/[id]/preview` was briefly owner-gated too, on the reasoning
 * that its signed `/preview-static` URL is an anonymous capability. The gate was
 * removed deliberately: this is a single-workspace product where the project list
 * shows every member every project, so owner-only minting rendered a teammate's
 * finished site as "Nothing to preview yet". What is asserted instead is the
 * property that actually matters — the token is scoped to the project id in the
 * URL, never to anything the caller supplies — plus that an anonymous caller is
 * still refused before anything is signed.
 *
 * Goes red if the write gate is removed, if a gate is added whose result is
 * dropped (every write case asserts the post-gate work did not run), or if token
 * minting stops being scoped to the requested project.
 *
 * Modules under test are pulled in with `await import` inside each case, as the
 * sibling unit tests do: a static import would bind before `vi.mock` registers,
 * and `getSessionUser` has to be re-stubbed per actor before the module loads.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const preview = vi.hoisted(() => ({ issuePreviewToken: vi.fn(), signedPreviewUrl: vi.fn() }));
const previewStatus = vi.hoisted(() => ({ getPreviewStatus: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
  },
}));

/** next-auth cannot resolve `next/server` outside the Next runtime. */
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));

/** The AsyncLocalStorage actor seam must stay empty: the session is the gate under test. */
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => undefined,
  applyCreateProjectPlanFlow: async () => undefined,
}));

/** Post-gate work for the persist path, so a missed gate is visible as a call count. */
vi.mock('@/lib/checkpoints/actions', () => ({
  createCheckpointAfterGeneration: vi.fn(async () => null),
}));
vi.mock('@/lib/memory/extract', () => ({ extractMemoriesAfterGeneration: async () => undefined }));
vi.mock('@/lib/signals/collect', () => ({
  countVisualEditsFromSource: () => 0,
  recordVisualEditRate: async () => undefined,
  maybeSettleFollowups: async () => undefined,
}));
vi.mock('@/lib/preview/production', () => ({ buildPreviewForProject: async () => ({ ok: true }) }));

/** Post-gate work for the preview route. */
vi.mock('@/lib/preview/token', () => ({ issuePreviewToken: preview.issuePreviewToken }));
vi.mock('@/lib/preview/url', () => ({ signedPreviewUrl: preview.signedPreviewUrl }));
vi.mock('@/lib/preview/status', () => ({ getPreviewStatus: previewStatus.getPreviewStatus }));

const OWNER = { id: 'u-owner', email: 'owner@example.com', name: 'Owner', role: 'MEMBER' as const };
const OTHER = { id: 'u-other', email: 'other@example.com', name: 'Other', role: 'MEMBER' as const };
const ADMIN = { id: 'u-admin', email: 'admin@example.com', name: 'Admin', role: 'ADMIN' as const };
const PROJECT = 'p-authz';

function params() {
  return { params: Promise.resolve({ id: PROJECT }) };
}

function tokenRequest() {
  return new NextRequest(`http://localhost:3000/api/projects/${PROJECT}/preview`, {
    method: 'POST',
    body: JSON.stringify({ action: 'token' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, ownerId: OWNER.id, phase: 'BUILDING' });
  db.projectUpdate.mockResolvedValue({ id: PROJECT, previewUrl: null, owner: OWNER });
  preview.issuePreviewToken.mockReturnValue('signed.token');
  preview.signedPreviewUrl.mockResolvedValue(`/preview-static/${PROJECT}/?t=signed.token`);
  previewStatus.getPreviewStatus.mockResolvedValue({
    status: 'READY',
    buildLog: 'secret build log',
  });
});

describe('persistProjectGeneration ownership', () => {
  it('refuses a non-owner member and writes nothing', async () => {
    auth.getSessionUser.mockResolvedValue(OTHER);
    const { persistProjectGeneration } = await import('@/lib/projects/actions');

    const result = await persistProjectGeneration(PROJECT, {
      lastCode: '<file path="src/App.jsx">overwritten</file>',
      generationStatus: 'ready',
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 403, error: 'Forbidden' });
    expect(db.projectUpdate).not.toHaveBeenCalled();
  });

  it('selects ownerId, so the gate has something to compare', async () => {
    auth.getSessionUser.mockResolvedValue(OTHER);
    const { persistProjectGeneration } = await import('@/lib/projects/actions');

    await persistProjectGeneration(PROJECT, { lastCode: 'x' });

    // The original bug was not a missing `if` — it was a lookup that never
    // fetched the field, which is why the dead `user` binding went unnoticed.
    expect(db.projectFindFirst.mock.calls[0]?.[0]?.select).toMatchObject({ ownerId: true });
  });

  it('still lets the owner persist', async () => {
    // Control: the 403s above must not be a broken path.
    auth.getSessionUser.mockResolvedValue(OWNER);
    const { persistProjectGeneration } = await import('@/lib/projects/actions');

    const result = await persistProjectGeneration(PROJECT, { lastCode: 'mine' });

    expect(result.ok).toBe(true);
    expect(db.projectUpdate).toHaveBeenCalledTimes(1);
  });

  it('still lets an ADMIN persist', async () => {
    auth.getSessionUser.mockResolvedValue(ADMIN);
    const { persistProjectGeneration } = await import('@/lib/projects/actions');

    const result = await persistProjectGeneration(PROJECT, { lastCode: 'admin fix' });

    expect(result.ok).toBe(true);
    expect(db.projectUpdate).toHaveBeenCalledTimes(1);
  });

  it('refuses an anonymous caller before the lookup', async () => {
    auth.getSessionUser.mockResolvedValue(null);
    const { persistProjectGeneration } = await import('@/lib/projects/actions');

    const result = await persistProjectGeneration(PROJECT, { lastCode: 'x' });

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(db.projectFindFirst).not.toHaveBeenCalled();
  });
});

describe('POST /api/projects/[id]/preview token minting', () => {
  it('mints for any signed-in member, because the project list already shows them the project', async () => {
    // Deliberate product decision, and a reversal of the first fix here. Owner-only
    // minting meant a member who opened a teammate's finished project saw "Nothing
    // to preview yet" over stored code, because both the Code tab and the in-browser
    // preview go through this route. Navroop is a single-workspace product.
    auth.getSessionUser.mockResolvedValue(OTHER);
    const { POST } = await import('@/app/api/projects/[id]/preview/route');

    const response = await POST(tokenRequest(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ token: 'signed.token' });
  });

  it('scopes the minted token to the project in the URL, never to a caller-supplied id', async () => {
    // This is the property that actually protects `/preview-static`, where the
    // signature is the only check performed and no session is involved. A token
    // minted here must not be usable against another project.
    auth.getSessionUser.mockResolvedValue(OTHER);
    const { POST } = await import('@/app/api/projects/[id]/preview/route');

    await POST(tokenRequest(), params());

    expect(preview.issuePreviewToken).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT }),
    );
    expect(preview.signedPreviewUrl).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT }),
    );
  });

  it('mints for the owner', async () => {
    auth.getSessionUser.mockResolvedValue(OWNER);
    const { POST } = await import('@/app/api/projects/[id]/preview/route');

    const response = await POST(tokenRequest(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ token: 'signed.token' });
    expect(preview.issuePreviewToken).toHaveBeenCalledTimes(1);
  });

  it('mints for an ADMIN', async () => {
    auth.getSessionUser.mockResolvedValue(ADMIN);
    const { POST } = await import('@/app/api/projects/[id]/preview/route');

    const response = await POST(tokenRequest(), params());

    expect(response.status).toBe(200);
    expect(preview.issuePreviewToken).toHaveBeenCalledTimes(1);
  });

  it('still refuses an anonymous caller, before signing anything', async () => {
    auth.getSessionUser.mockResolvedValue(null);
    const { POST } = await import('@/app/api/projects/[id]/preview/route');

    const response = await POST(tokenRequest(), params());

    expect(response.status).toBe(401);
    expect(preview.issuePreviewToken).not.toHaveBeenCalled();
    expect(preview.signedPreviewUrl).not.toHaveBeenCalled();
  });
});

describe('GET /api/projects/[id]/preview', () => {
  it('answers any signed-in member', async () => {
    auth.getSessionUser.mockResolvedValue(OTHER);
    const { GET } = await import('@/app/api/projects/[id]/preview/route');

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/projects/${PROJECT}/preview`),
      params(),
    );

    expect(response.status).toBe(200);
    expect(previewStatus.getPreviewStatus).toHaveBeenCalledTimes(1);
  });

  it('refuses an anonymous caller before reading status', async () => {
    auth.getSessionUser.mockResolvedValue(null);
    const { GET } = await import('@/app/api/projects/[id]/preview/route');

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/projects/${PROJECT}/preview`),
      params(),
    );

    expect(response.status).toBe(401);
    expect(previewStatus.getPreviewStatus).not.toHaveBeenCalled();
  });

  it('still answers the owner', async () => {
    auth.getSessionUser.mockResolvedValue(OWNER);
    const { GET } = await import('@/app/api/projects/[id]/preview/route');

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/projects/${PROJECT}/preview`),
      params(),
    );

    expect(response.status).toBe(200);
    expect(previewStatus.getPreviewStatus).toHaveBeenCalledTimes(1);
  });
});
