import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Round 5, defect C: a build spent up to six image credits on pictures nothing referenced.
 *
 * The settle routed the `NEED_IMAGE:` lines a model wrote as prose into
 * `fulfillNeedImagesFromReply`, capped at six. There is no token to rewrite in a reply, so
 * the pictures were generated and stored as `ProjectAsset` rows and nothing else — no
 * `<img>`, no `next/image`, no `backgroundImage` anywhere in the site pointed at them. The
 * generation is real spend: `attemptGeneration` treats the run as paid whenever no image
 * worker is configured, and `docker-compose.yml` defaults `IMAGE_WORKER_URL` to empty, so
 * the paid provider is the default deployment path. The user asked for a cafe landing page,
 * was debited six credits, and was told in chat that the pictures existed and to ask for
 * them to be placed — which costs another generation. Before this feature they got zero
 * images and paid nothing.
 *
 * So the settle counts the prose requests and buys none. The token written into a `src` is
 * still fulfilled by `resolveImages`, which is the path where the picture actually lands on
 * the page; getting the model to write it there is a separate fix in the same round.
 */

const prisma = vi.hoisted(() => ({
  project: { findUnique: vi.fn(), updateMany: vi.fn() },
  checkpoint: { count: vi.fn() },
  user: { findUnique: vi.fn() },
}));
const jobs = vi.hoisted(() => ({
  getJob: vi.fn(),
  succeedJob: vi.fn(),
  failJob: vi.fn(),
}));
const fulfil = vi.hoisted(() => ({
  fulfillNeedImages: vi.fn(),
  fulfillNeedImagesFromReply: vi.fn(),
  imageFulfilmentNotice: vi.fn(),
}));
const audit = vi.hoisted(() => ({ runAutoCodeAudit: vi.fn(), runCodeAudit: vi.fn() }));
const seo = vi.hoisted(() => ({ runAutoSeoAudit: vi.fn(), runSeoAudit: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/jobs/store', () => ({ getJob: jobs.getJob }));
vi.mock('@/lib/jobs/lifecycle', () => ({
  succeedJob: jobs.succeedJob,
  failJob: jobs.failJob,
}));
vi.mock('@/lib/assets/fulfill', () => fulfil);
vi.mock('@/lib/audit/actions', () => audit);
vi.mock('@/lib/seo/actions', () => seo);
vi.mock('@/lib/projects/plan', () => ({
  runWithActor: <T>(_user: unknown, fn: () => T): T => fn(),
}));

import { replyDescribedImagesNotice, settleStreamedGeneration } from '@/lib/jobs/settle-generation';

const JOB = 'job_settle_images';
const PROJECT = 'proj_settle_images';
const USER = 'user_settle_images';

/** Verbatim shape from the live run: the requests are prose, the file has none. */
const PROSE_REPLY = [
  'I have built the Chai Point landing page.',
  '',
  'NEED_IMAGE: Interior of a cozy tea cafe with warm lighting | 16:9 | Hero background',
  'NEED_IMAGE: Open graph image with Chai Point branding | 1200x630',
  '',
  '```tsx{path=app/page.tsx}',
  'export default function Page() {',
  '  return <main>Chai Point</main>;',
  '}',
  '```',
].join('\n');

/** The settle detaches the scans, so give the microtask queue a turn. */
const settleTicks = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  vi.clearAllMocks();
  jobs.getJob.mockResolvedValue({
    id: JOB,
    projectId: PROJECT,
    userId: USER,
    status: 'RUNNING',
    errorCode: null,
    errorMessage: null,
  });
  jobs.succeedJob.mockResolvedValue(undefined);
  jobs.failJob.mockResolvedValue(undefined);
  prisma.project.findUnique.mockResolvedValue({ lastCode: null, contentVersion: 0 });
  prisma.project.updateMany.mockResolvedValue({ count: 1 });
  prisma.checkpoint.count.mockResolvedValue(0);
  prisma.user.findUnique.mockResolvedValue({
    id: USER,
    email: 'settle@example.com',
    name: 'Settle',
    role: 'MEMBER',
    avatarUrl: null,
    isActive: true,
  });
  fulfil.fulfillNeedImages.mockImplementation(
    async (input: { files: Array<{ path: string; content: string }> }) =>
      Object.assign([...input.files], { requested: 0, fulfilled: 0, unfulfilled: [] }),
  );
  fulfil.imageFulfilmentNotice.mockReturnValue('one image could not be produced');
  audit.runAutoCodeAudit.mockResolvedValue({ ok: true, data: { scanning: true } });
  seo.runAutoSeoAudit.mockResolvedValue({ ok: true, data: { scanning: true } });
});

describe('a picture the page does not reference is not bought', () => {
  it('never reaches the paid reply-fulfilment path', async () => {
    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });

    expect(result.outcome).toBe('succeeded');
    // `fulfillNeedImagesFromReply` is what debited an image credit per picture through
    // `attemptGeneration`, capped at six, for assets nothing on the page points at.
    expect(fulfil.fulfillNeedImagesFromReply).not.toHaveBeenCalled();
  });

  it('still counts them, so the silence is not the other failure', async () => {
    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });

    expect(result.images).toMatchObject({ replyDescribed: 2 });
  });

  it('tells chat they were not created, never that they were added to Assets', async () => {
    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });

    expect(result.imageNotice).toBe(replyDescribedImagesNotice(2));
    expect(result.imageNotice).toContain('were not created');
    // The old sentence claimed assets existed because the settle had just paid for them.
    expect(result.imageNotice).not.toMatch(/added to Assets/i);
  });

  it('does not double-count a picture that was also asked for in a file', async () => {
    const bothPlaces = [
      'NEED_IMAGE: Hero shot of a tea cafe | 16:9',
      '',
      '```tsx{path=app/page.tsx}',
      'export const hero = "NEED_IMAGE: Hero shot of a tea cafe | 16:9";',
      '```',
    ].join('\n');

    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: bothPlaces,
    });

    // That one was placed in a `src` and fulfilled by `resolveImages`. Reporting it as
    // "described but not created" would be a false alarm about a picture on the page.
    expect(result.images).toMatchObject({ replyDescribed: 0 });
    expect(result.imageNotice).toBeNull();
  });

  it('says nothing at all when the reply names no picture', async () => {
    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: '```tsx{path=app/page.tsx}\nexport default () => null;\n```',
    });

    expect(result.images).toMatchObject({ replyDescribed: 0 });
    expect(result.imageNotice).toBeNull();
  });
});

describe('the in-file path is untouched: those pictures are on the page', () => {
  it('still fulfils tokens written into the files, and still reports a provider miss', async () => {
    fulfil.fulfillNeedImages.mockImplementation(
      async (input: { files: Array<{ path: string; content: string }> }) =>
        Object.assign([...input.files], {
          requested: 3,
          fulfilled: 2,
          unfulfilled: [{ description: 'x', aspect: '16:9', reason: 'rate limited' }],
        }),
    );

    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: '```tsx{path=app/page.tsx}\nexport default () => null;\n```',
    });

    expect(fulfil.fulfillNeedImages).toHaveBeenCalledTimes(1);
    expect(result.images).toMatchObject({ inFileRequested: 3, inFileFulfilled: 2, unfulfilled: 1 });
    // `fromReply: 0` always now — nothing on this path creates a picture from the reply,
    // so there is never a "created and added to Assets" count to pass.
    expect(fulfil.imageFulfilmentNotice).toHaveBeenCalledWith({ fromReply: 0, unfulfilled: 1 });
  });

  it('joins both sentences when a build did both', async () => {
    fulfil.fulfillNeedImages.mockImplementation(
      async (input: { files: Array<{ path: string; content: string }> }) =>
        Object.assign([...input.files], {
          requested: 1,
          fulfilled: 0,
          unfulfilled: [{ description: 'y', aspect: '1:1', reason: 'no provider' }],
        }),
    );

    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });

    expect(result.imageNotice).toContain('were not created');
    expect(result.imageNotice).toContain('one image could not be produced');
  });
});

describe('a failing settle spends nothing and says nothing', () => {
  it('does not count reply requests on a build that produced no files', async () => {
    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 0,
      streamedCode: 'I could not do that. NEED_IMAGE: a cafe | 16:9',
    });
    await settleTicks();

    expect(result.outcome).toBe('failed');
    expect(fulfil.fulfillNeedImagesFromReply).not.toHaveBeenCalled();
    expect(audit.runAutoCodeAudit).not.toHaveBeenCalled();
  });
});

describe('the automatic scan is the unmetered one, still', () => {
  it('never reaches the Scan button’s metered actions', async () => {
    await settleStreamedGeneration({ jobId: JOB, producedFiles: 1, streamedCode: PROSE_REPLY });
    await settleTicks();

    expect(audit.runAutoCodeAudit).toHaveBeenCalledWith(PROJECT, JOB);
    expect(seo.runAutoSeoAudit).toHaveBeenCalledWith(PROJECT, JOB);
    expect(audit.runCodeAudit).not.toHaveBeenCalled();
    expect(seo.runSeoAudit).not.toHaveBeenCalled();
  });
});
