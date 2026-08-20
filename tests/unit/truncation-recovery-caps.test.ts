import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JobCapError, JobCapTracker } from '@/lib/consumption/caps';
import { collectRecoveredStreamText } from '@/lib/generation/truncation-recovery';

/**
 * Truncation recovery is a second generation and the per-job caps must bound it (F-042).
 *
 * The main stream loop feeds every chunk to `capTracker.addChunk` and so does the
 * corrective ask. `collectRecoveredStreamText` only accumulated text, and the recovery
 * loop runs once per truncated file — each call bounded by its own `maxOutputTokens` and
 * nothing bounded the sum. A reply with several truncated files could therefore spend N
 * times `maxTokensPerJob` without the cap firing once, on the path most likely to need it.
 */

function fakeStream(chunks: string[]) {
  return {
    textStream: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
    text: Promise.resolve(chunks.join('')),
  };
}

function tinyTracker() {
  return new JobCapTracker({
    maxTokensPerJob: 20,
    maxFilesPerJob: 5,
    maxOutputBytesPerJob: 80,
  });
}

describe('collectRecoveredStreamText counts against the job caps', () => {
  it('returns the text and charges the tracker when the recovery stays under the caps', async () => {
    const tracker = tinyTracker();
    const text = await collectRecoveredStreamText(fakeStream(['const a = ', '1;']), (chunk) =>
      tracker.addChunk(chunk),
    );

    expect(text).toBe('const a = 1;');
    // The bytes are on the job now, so the *next* call sees a smaller remaining budget —
    // which is the whole point: the bound is per job, not per recovery call.
    expect(tracker.bytes).toBe(12);
    expect(tracker.tokensOut).toBeGreaterThan(0);
  });

  it('aborts mid-stream when the recovery pushes the job past its cap', async () => {
    const tracker = tinyTracker();
    const chunks = ['x'.repeat(40), 'y'.repeat(200), 'z'.repeat(40)];

    await expect(
      collectRecoveredStreamText(fakeStream(chunks), (chunk) => tracker.addChunk(chunk)),
    ).rejects.toBeInstanceOf(JobCapError);

    // Mid-stream, not after draining: the third chunk was never read.
    expect(tracker.bytes).toBe(240);
  });

  it('carries an already-spent job budget into the recovery call', async () => {
    const tracker = tinyTracker();
    // The main stream already spent most of the job.
    expect(tracker.addChunk('x'.repeat(70))).toBeNull();

    await expect(
      collectRecoveredStreamText(fakeStream(['y'.repeat(20)]), (chunk) => tracker.addChunk(chunk)),
    ).rejects.toBeInstanceOf(JobCapError);
  });

  it('still counts nothing when no counter is passed', async () => {
    const text = await collectRecoveredStreamText(fakeStream(['a', 'b']));
    expect(text).toBe('ab');
  });
});

/**
 * The route is where the tracker meets the recovery loop, and a cap abort there must not
 * be classified as a provider failure: `truncationRecoveryOutcome` would tell the user
 * their build was incomplete because of a vendor outage. Asserted against the source
 * because the surrounding handler is a 2000-line streaming route with no seam — the same
 * reason `tests/unit/answer-turn-route-wiring.test.ts` reads it this way.
 */
describe('the generate route wires the tracker into recovery', () => {
  const source = readFileSync('app/api/generate-ai-code-stream/route.ts', 'utf8');
  const loop = source.slice(
    source.indexOf('for (const truncatedFile of truncatedFiles)'),
    source.indexOf('if (recoveryFailure) {', source.indexOf('for (const truncatedFile of')),
  );

  it('passes a capTracker.addChunk counter to collectRecoveredStreamText', () => {
    expect(loop).toContain('collectRecoveredStreamText');
    expect(loop).toMatch(/collectRecoveredStreamText\([\s\S]*?capTracker\.addChunk\(/);
  });

  it('rethrows a JobCapError instead of reporting a provider failure', () => {
    expect(loop).toMatch(
      /catch \(completionError\) \{\s*\n\s*if \(completionError instanceof JobCapError\) throw completionError;/,
    );
  });
});
