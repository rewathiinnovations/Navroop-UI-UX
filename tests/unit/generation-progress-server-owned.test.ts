/**
 * The browser does not report a build's progress. The server does.
 *
 * T4, measured with a fetch interceptor in the live workspace across one 15-second build:
 *
 *     PATCH /api/projects/{id}  {"status":"generating","progressMessage":"Starting AI generation..."}
 *     PATCH /api/projects/{id}  {"status":"generating","progressMessage":"Generating code..."}  ×3, byte-identical
 *
 * The first came from `setJobStatus('generating')`, the other three from a
 * `setInterval(…, 4000)` armed beside it, and they repeated verbatim because
 * `generationProgress.status` had not moved between ticks. Every one of them wrote a
 * column the server already owns: `markJobRunning` (lib/jobs/lifecycle.ts) sets
 * `generationStatus: 'generating'` with phase BUILDING when the job starts,
 * `createProgressBatcher` (lib/jobs/progress.ts) writes the step and the partial files
 * onto the Job row, and the settle path writes `ready`/`idle`/`error` back — all of it
 * polled by the workspace through `GET /api/projects/{id}/job`. A tab closed mid-build
 * left `generating` on the row with nobody to correct it.
 *
 * What must NOT go with it is the one terminal PATCH. `generationStatus: 'ready'` is the
 * only trigger for `persistProjectGeneration`'s after-generation work — the
 * `contentVersion` bump, `createCheckpointAfterGeneration` and
 * `capturePreviewAfterGeneration`, which nothing else in the repo calls — so the last
 * block below pins that the surviving write still reaches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGeneration,
  executeGenerationJob,
  getGenerationState,
  markGenerationError,
  setGenerationProjectId,
  startApply,
  startGeneration,
  subscribeGenerationJobs,
} from '../../lib/generation/generation-runtime';
import { hasGenerationFields, readGenerationInput } from '../../lib/projects/http';

const PROJECT = 'proj-1';
const FILE_BLOCK = '<file path="src/App.jsx">export default function App() { return null; }</file>';

type SentRequest = { url: string; method: string; body: Record<string, unknown> };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** An SSE body this test holds open, so the runtime sits in `generating` on demand. */
function openSseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(open) {
      controller = open;
    },
  });
  return {
    stream,
    /** The parser splits on newlines and reads `data: ` lines, so one is a whole frame. */
    frame(payload: unknown) {
      if (closed) return;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n`));
    },
    /** Idempotent: the teardown closes what a test may already have closed. */
    end() {
      if (closed) return;
      closed = true;
      controller.close();
    },
  };
}

/**
 * Records every project write. The generate POST and the reattach poll are answered
 * separately and deliberately not recorded — the claim under test is about writes to the
 * project row, and counting the reads the drop path makes would hide a regression in them.
 */
function stubWorkspaceFetch(sent: SentRequest[], sse?: ReturnType<typeof openSseStream>) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/generate-ai-code-stream')) {
      return Promise.resolve(
        new Response(sse?.stream ?? null, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }
    // `/api/projects/{id}/job` — the reattach poll after a dropped stream. No job row
    // stops `resumeStep` on its first pass, so the run ends without a timer to advance.
    if (url.includes('/job')) return Promise.resolve(jsonResponse({ job: null }));
    sent.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return Promise.resolve(jsonResponse({ project: { id: PROJECT } }));
  });
}

describe('a build in flight writes nothing to the project row (T4)', () => {
  let unsubscribe: () => void;
  let sent: SentRequest[];
  let sse: ReturnType<typeof openSseStream>;
  let inFlight: Promise<unknown> | null;

  beforeEach(() => {
    vi.useFakeTimers();
    clearGeneration();
    unsubscribe = subscribeGenerationJobs(executeGenerationJob);
    setGenerationProjectId(PROJECT);
    sent = [];
    sse = openSseStream();
    inFlight = null;
    stubWorkspaceFetch(sent, sse);
  });

  // The teardown ends the stream itself rather than trusting the body to have reached
  // its own `sse.end()`. A failed expectation aborts the test where it stands, and a
  // build left mid-stream leaves the read loop parked on a promise nothing will ever
  // settle — so the first regression this file catches would hang the run instead of
  // reporting itself.
  afterEach(async () => {
    sse.end();
    await inFlight?.catch(() => {});
    unsubscribe();
    clearGeneration();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Starts a build and hands the promise to the teardown, so no path can strand it. */
  function startTrackedBuild() {
    inFlight = startGeneration({ prompt: 'Build a landing page', model: '' });
    return inFlight;
  }

  it('sends no PATCH at all across fifteen seconds of streaming', async () => {
    const run = startTrackedBuild();

    // `runGenerateStream` runs synchronously as far as its `fetch`, so the status has
    // already moved and the old immediate write has already gone out by this line.
    expect(getGenerationState().status).toBe('generating');
    expect(sent).toEqual([]);

    // The frame that made three of the four measured PATCHes byte-identical: after it
    // `generationProgress.status` stops moving for the rest of the build.
    sse.frame({ type: 'status', message: 'Generating code...' });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(sent).toEqual([]);

    sse.end();
    await run;

    // The stream ended with no terminal frame — a transport drop. The verdict is the
    // server's, so the whole run still wrote nothing (F-036).
    expect(sent).toEqual([]);
  });

  it('repeats no identical body while the run sits on the same step', async () => {
    startTrackedBuild();
    sse.frame({ type: 'status', message: 'Generating code...' });
    // Measured from here, so this case is about the repeats rather than the one write
    // that opened the build — those were separate defects with separate causes.
    const before = sent.length;

    await vi.advanceTimersByTimeAsync(15_000);

    // Compared as serialized bodies: the finding was not "too many writes" but the same
    // bytes three times, which is what proves nothing was being reported.
    expect(sent.slice(before).map((request) => JSON.stringify(request.body))).toEqual([]);
  });

  it('arms no repeating timer to be woken by later work', async () => {
    startTrackedBuild();
    sse.frame({ type: 'status', message: 'Generating code...' });
    await vi.advanceTimersByTimeAsync(4_000);

    // A 4s interval that survived would still be pending here, and each tick was one
    // more identical PATCH. Counted rather than inferred from `sent`, so a timer that
    // was armed and merely wrote nothing this second is still a failure.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the terminal write survives, once, and carries no progress text', () => {
  let unsubscribe: () => void;
  let sent: SentRequest[];

  beforeEach(() => {
    clearGeneration();
    unsubscribe = subscribeGenerationJobs(executeGenerationJob);
    setGenerationProjectId(PROJECT);
    sent = [];
    stubWorkspaceFetch(sent);
  });

  afterEach(() => {
    unsubscribe();
    clearGeneration();
    vi.unstubAllGlobals();
  });

  it('settles a finished run with exactly one PATCH, and it says ready', async () => {
    // `startApply` passes through `applying` on its way to `ready`; that intermediate
    // status used to be a PATCH of its own on top of the interval it armed.
    await startApply({ code: FILE_BLOCK, isEdit: false });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('PATCH');
    expect(sent[0]?.url).toBe(`/api/projects/${PROJECT}`);
    expect(sent[0]?.body.status).toBe('ready');
    expect(sent[0]?.body).not.toHaveProperty('progressMessage');
    expect(getGenerationState().status).toBe('ready');
  });

  it('still reaches the after-generation work that only `ready` triggers', () => {
    // Replayed through the server's own parser rather than asserted by eye: this is the
    // body `persistProjectGeneration` has to recognise before it bumps `contentVersion`,
    // cuts the checkpoint and builds the preview.
    const parsed = readGenerationInput({ status: 'ready', previewUrl: null });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.data.generationStatus).toBe('ready');
    expect(hasGenerationFields(parsed.data)).toBe(true);
  });

  it('reports a failure without pasting the message onto the project row', async () => {
    // The error text used to ride along as `progressMessage`. Nothing renders that
    // column; `Job.errorMessage` is what the recovery panel and /admin/jobs read.
    markGenerationError('The provider rejected the key.');
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]?.body.status).toBe('error');
    expect(sent[0]?.body).not.toHaveProperty('progressMessage');
    expect(JSON.stringify(sent[0]?.body)).not.toContain('The provider rejected the key.');
  });
});

describe('the server still accepts what legitimately writes these columns', () => {
  it('keeps the legacy `status` alias the terminal write uses', () => {
    const parsed = readGenerationInput({ status: 'error' });
    expect(parsed.ok && parsed.data.generationStatus).toBe('error');
  });

  it('still parses progressMessage, which the URL-import path writes server-side', () => {
    // `lib/import/run.ts` calls `persistProjectGeneration` directly rather than through
    // this parser, so nothing sends this over HTTP any more — but narrowing the contract
    // is a separate change, and silently dropping the field here would be worse than
    // leaving it: an import PATCH would 400 on nothing but a message.
    const parsed = readGenerationInput({ generationStatus: 'generating', progressMessage: 'x' });
    expect(parsed.ok && parsed.data.progressMessage).toBe('x');
  });
});
