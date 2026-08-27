import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Three properties of the settle path, all of them regressions from one live run
 * (deepseek-v4-flash, NEXTJS, a cafe landing page):
 *
 *  1. The model wrote all four picture requests as prose in its reply rather than
 *     into a `src`. `fulfillNeedImages` reads file contents only, so nothing was
 *     parsed, nothing was generated, and `/api/projects/{id}/assets` answered
 *     `{"assets":[]}` on a cafe page with no photographs. Making the settle *buy*
 *     those pictures left the page exactly as empty and debited up to six image
 *     credits a build for assets nothing referenced, so the settle now counts them
 *     and buys none; getting the token into the `src` is the generate route's one
 *     corrective ask (`tests/unit/reply-owed-images.test.ts`), and the "buys none"
 *     half is pinned in `tests/unit/settle-buys-no-unplaced-images.test.ts`. What
 *     this file owns is the boundary: which count each picture lands in, and which
 *     sentence speaks for it.
 *  2. Two successful builds later, `.../audit` and `.../seo` both still answered
 *     `{"audit":null,"scanning":false,"hasFiles":true}` — both subsystems worked
 *     and nothing had ever called them.
 *  3. Neither may be able to lose a finished build. An image provider that is down
 *     and a scan that throws are conditions the settle has to survive, not report.
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
// `fulfillNeedImagesFromReply` is the paid path the settle no longer takes. It stays
// declared, with no default answer, only so the guards below can name it: a call that came
// back would be image credits spent again on pictures the page does not reference.
const fulfil = vi.hoisted(() => ({
  fulfillNeedImages: vi.fn(),
  fulfillNeedImagesFromReply: vi.fn(),
  imageFulfilmentNotice: vi.fn(),
}));
/**
 * The directive parser, real by default and throwable on demand.
 *
 * Counting the reply's prose requests is cosmetic — it buys nothing and rewrites no file —
 * so a build already merged into `lastCode` must not be lost to it. Half of that count used
 * to be computed in the call site's argument list, outside `countReplyOnlyImageRequests`'s
 * own try/catch and between the site write and `succeedJob`, so a parser failure over the
 * file bodies threw past the guard and cost the user a build that had finished.
 */
const needImage = vi.hoisted(() => ({ parseThrows: false }));
const audit = vi.hoisted(() => ({
  isCodeScanInFlight: vi.fn(),
  runCodeAudit: vi.fn(),
  runAutoCodeAudit: vi.fn(),
}));
const seo = vi.hoisted(() => ({
  isSeoScanInFlight: vi.fn(),
  runSeoAudit: vi.fn(),
  runAutoSeoAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/jobs/store', () => ({ getJob: jobs.getJob }));
vi.mock('@/lib/jobs/lifecycle', () => ({
  succeedJob: jobs.succeedJob,
  failJob: jobs.failJob,
}));
vi.mock('@/lib/assets/fulfill', () => fulfil);
vi.mock('@/lib/assets/need-image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assets/need-image')>();
  return {
    ...actual,
    parseNeedImageDirectives: (...args: Parameters<typeof actual.parseNeedImageDirectives>) => {
      if (needImage.parseThrows) throw new Error('directive parser blew up');
      return actual.parseNeedImageDirectives(...args);
    },
  };
});
vi.mock('@/lib/audit/actions', () => audit);
vi.mock('@/lib/seo/actions', () => seo);
// The scans resolve their actor through `peekActor()`; the settle supplies the job's
// own user because it runs past the point where reading the request session is safe.
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
  needImage.parseThrows = false;
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
  fulfil.imageFulfilmentNotice.mockReturnValue('two images could not be produced');
  audit.isCodeScanInFlight.mockResolvedValue({ ok: true, data: { inFlight: false } });
  audit.runCodeAudit.mockResolvedValue({ ok: true, data: { scanning: true } });
  audit.runAutoCodeAudit.mockResolvedValue({ ok: true, data: { scanning: true } });
  seo.isSeoScanInFlight.mockResolvedValue({ ok: true, data: { inFlight: false } });
  seo.runSeoAudit.mockResolvedValue({ ok: true, data: { scanning: true } });
  seo.runAutoSeoAudit.mockResolvedValue({ ok: true, data: { scanning: true } });
});

describe('a picture asked for in prose is counted, never bought', () => {
  it('counts what the reply described and reaches no image provider for it', async () => {
    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });

    expect(result.outcome).toBe('succeeded');
    // Buying them produced a `ProjectAsset` row and nothing else — no `<img>`, no
    // `next/image`, no `backgroundImage` anywhere in the site pointed at one — for up to
    // six image credits a build. Counting them is what keeps the silence from being the
    // other failure, where four photographs are asked for and nothing says why the page
    // has none.
    expect(fulfil.fulfillNeedImagesFromReply).not.toHaveBeenCalled();
    expect(result.images).toMatchObject({ replyDescribed: 2, inFileRequested: 0 });
  });

  it('counts a picture the files also asked for on the in-file side only', async () => {
    const bothPlaces = [
      'NEED_IMAGE: Hero shot of a tea cafe | 16:9',
      '',
      '```tsx{path=app/page.tsx}',
      'export const hero = "NEED_IMAGE: Hero shot of a tea cafe | 16:9";',
      '```',
    ].join('\n');
    fulfil.fulfillNeedImages.mockImplementation(
      async (input: { files: Array<{ path: string; content: string }> }) =>
        Object.assign([...input.files], { requested: 1, fulfilled: 1, unfulfilled: [] }),
    );

    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: bothPlaces,
    });

    // One picture, one count. The file's token was rewritten and paid for by
    // `resolveImages`, so it is on the page; counting it again as described-but-not-created
    // would send the user to ask for a picture they already have. The dedupe is on
    // `needImageKey` — the same key fulfilment uses — over the reply's own file bodies.
    expect(result.images).toMatchObject({
      inFileRequested: 1,
      inFileFulfilled: 1,
      replyDescribed: 0,
      unfulfilled: 0,
    });
  });

  it('asks for nothing when the reply names no picture', async () => {
    await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: '```tsx{path=app/page.tsx}\nexport default () => null;\n```',
    });

    expect(fulfil.fulfillNeedImagesFromReply).not.toHaveBeenCalled();
    expect(fulfil.imageFulfilmentNotice).not.toHaveBeenCalled();
  });

  it('reports them in their own sentence, not the fulfilment one', async () => {
    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });

    // `imageFulfilmentNotice` speaks for pictures a provider was asked for and could not
    // produce. No provider was asked here, so it is not called at all — and the sentence it
    // used to compose, "two pictures were added to Assets", was true only because the
    // settle had just paid for them.
    expect(fulfil.imageFulfilmentNotice).not.toHaveBeenCalled();
    expect(result.imageNotice).toBe(replyDescribedImagesNotice(2));
    expect(result.imageNotice).not.toMatch(/added to Assets/i);
  });

  it('keeps the two counts apart: a described picture is never an unfulfilled one', async () => {
    fulfil.fulfillNeedImages.mockImplementation(
      async (input: { files: Array<{ path: string; content: string }> }) =>
        Object.assign([...input.files], {
          requested: 3,
          fulfilled: 1,
          unfulfilled: [{ description: 'x', aspect: '16:9', reason: 'rate limited' }],
        }),
    );

    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });

    // `unfulfilled` means a provider was asked and could not serve — the two in-file misses
    // here, and only those. The reply's two were never attempted, so folding them in would
    // report four provider failures for two and invite a retry of something that never ran.
    expect(result.images).toMatchObject({
      inFileRequested: 3,
      inFileFulfilled: 1,
      unfulfilled: 2,
      replyDescribed: 2,
    });
    // Two owners, two sentences, joined. `fromReply: 0` is not a placeholder: nothing on
    // this path creates a picture from the reply, so there is no created count to pass.
    expect(fulfil.imageFulfilmentNotice).toHaveBeenCalledWith({ fromReply: 0, unfulfilled: 2 });
    expect(result.imageNotice).toContain(replyDescribedImagesNotice(2));
    expect(result.imageNotice).toContain('two images could not be produced');
  });
});

describe('nothing after the stream may lose a finished build', () => {
  it('settles succeeded when in-file fulfilment throws', async () => {
    fulfil.fulfillNeedImages.mockRejectedValue(new Error('image worker is down'));

    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });

    expect(result.outcome).toBe('succeeded');
    expect(jobs.succeedJob).toHaveBeenCalledWith(JOB, expect.anything());
    // The site is still stored, with the files exactly as they streamed.
    expect(prisma.project.updateMany).toHaveBeenCalled();
  });

  it('settles succeeded when counting the reply’s requests throws', async () => {
    needImage.parseThrows = true;

    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });

    // The count is the cheapest thing in the settle and the last: it buys nothing and
    // rewrites no file, and it runs after the merged-site write. Losing the build to it
    // would trade a chat sentence about photographs for the whole page.
    expect(result.outcome).toBe('succeeded');
    expect(jobs.succeedJob).toHaveBeenCalledWith(JOB, expect.anything());
    expect(prisma.project.updateMany).toHaveBeenCalled();
    // Only the count is lost, and the sentence with it — never invented as a number
    // nobody produced.
    expect(result.images).toMatchObject({ replyDescribed: 0 });
    expect(result.imageNotice).toBeNull();
  });

  it('settles succeeded when a scan throws', async () => {
    audit.runAutoCodeAudit.mockRejectedValue(new Error('audit exploded'));

    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });
    await settleTicks();

    expect(result.outcome).toBe('succeeded');
    expect(jobs.failJob).not.toHaveBeenCalled();
  });
});

describe('a settled build gets scanned', () => {
  it('starts both scans once the job is SUCCEEDED, naming the build as their warrant', async () => {
    await settleStreamedGeneration({ jobId: JOB, producedFiles: 1, streamedCode: PROSE_REPLY });
    await settleTicks();

    expect(audit.runAutoCodeAudit).toHaveBeenCalledWith(PROJECT, JOB);
    expect(seo.runAutoSeoAudit).toHaveBeenCalledWith(PROJECT, JOB);
    // Strictly after the terminal write: the scan's warrant is a build row that has
    // already settled SUCCEEDED, so asking before it is asking too early.
    expect(jobs.succeedJob.mock.invocationCallOrder[0]).toBeLessThan(
      audit.runAutoCodeAudit.mock.invocationCallOrder[0],
    );
  });

  /**
   * The round-1 defect, pinned at the point it was introduced. `runCodeAudit` /
   * `runSeoAudit` are the Scan button's actions: they take the project's one live job
   * row (`one_active_job_per_project`) for the length of the scan and charge an audit
   * credit through `markJobRunning({ chargeCredits: true })`. Called from here, the
   * user's next chat message was refused with "A build is already running on this
   * project" for a build that had finished, and a plan allowing 20 audits a month was
   * exhausted after 20 chat turns. Nothing the user did not ask for may reach them.
   */
  it('never reaches the metered Scan actions', async () => {
    await settleStreamedGeneration({ jobId: JOB, producedFiles: 1, streamedCode: PROSE_REPLY });
    await settleTicks();

    expect(audit.runCodeAudit).not.toHaveBeenCalled();
    expect(seo.runSeoAudit).not.toHaveBeenCalled();
  });

  it('reports a scan that had nothing to do without calling it a failure', async () => {
    audit.runAutoCodeAudit.mockResolvedValue({ ok: true, data: { scanning: false } });

    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 1,
      streamedCode: PROSE_REPLY,
    });
    await settleTicks();

    expect(result.outcome).toBe('succeeded');
    expect(jobs.failJob).not.toHaveBeenCalled();
  });

  it('does not scan for a deactivated owner', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: USER,
      email: 'settle@example.com',
      name: 'Settle',
      role: 'MEMBER',
      avatarUrl: null,
      isActive: false,
    });

    await settleStreamedGeneration({ jobId: JOB, producedFiles: 1, streamedCode: PROSE_REPLY });
    await settleTicks();

    expect(audit.runAutoCodeAudit).not.toHaveBeenCalled();
    expect(seo.runAutoSeoAudit).not.toHaveBeenCalled();
  });

  it('does not scan a build that failed', async () => {
    const result = await settleStreamedGeneration({
      jobId: JOB,
      producedFiles: 0,
      streamedCode: 'I could not do that.',
    });
    await settleTicks();

    expect(result.outcome).toBe('failed');
    expect(audit.runAutoCodeAudit).not.toHaveBeenCalled();
    expect(seo.runAutoSeoAudit).not.toHaveBeenCalled();
    // A failing settle must not spend image credits either.
    expect(fulfil.fulfillNeedImagesFromReply).not.toHaveBeenCalled();
  });
});
