import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Reloading the tab during a build must not cost the build.
 *
 * A real run got stuck exactly here: the person reloaded while a Next.js site
 * was generating, the request aborted, and three things followed. The stream
 * loop broke mid-site, so the reply was never complete. The route returned
 * before its settle, so the job row stayed RUNNING. And the heartbeat stopped
 * on abort, so the row looked stale while nothing was left to finish it — the
 * workspace showed "Building your project…" over a build that was already
 * over, with no error and no way back.
 *
 * The site is persisted server-side, so a departed browser changes nothing
 * about the work: finish the stream, persist, settle. This pins the shape of
 * that, since all three regressions are single lines that look harmless.
 */

const ROUTE = fileURLToPath(
  new URL('../../app/api/generate-ai-code-stream/route.ts', import.meta.url),
);
const LIFECYCLE = fileURLToPath(new URL('../../lib/jobs/lifecycle.ts', import.meta.url));

/** Source with comments stripped — the prose here quotes the old code. */
function live(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
}

describe('a disconnected client does not abandon the generation', () => {
  it('keeps consuming the model stream', () => {
    const source = live(ROUTE);
    expect(source).toContain('for await (const part of stream.fullStream');
    expect(source).not.toMatch(/if \(clientDisconnected\) break;/);
  });

  it('does not return before the job is settled', () => {
    const source = live(ROUTE);
    // The bare early exit that skipped persist + settle.
    expect(source).not.toMatch(/if \(clientDisconnected\) \{\s*return;\s*\}/);
    // The settle itself still has to be there.
    expect(source).toContain('settleStreamedGeneration({');
  });

  it('parses the reply before deciding nothing was produced', () => {
    const source = live(ROUTE);
    // The short-circuit that returned `files` before the parse ran. A real
    // build lost seven path-tagged fences to it.
    expect(source).not.toMatch(/return \{ generatedCode, files, morphEditBlocks: 0, stop: true/);
    // Parsing is the lenient block parser, and it has to be reached.
    const parseAt = source.indexOf('filesFromReply(generatedCode)');
    const disconnectAt = source.indexOf('client_left_mid_stream');
    expect(parseAt).toBeGreaterThan(-1);
    expect(disconnectAt).toBeGreaterThan(-1);
    expect(parseAt).toBeGreaterThan(disconnectAt);
  });

  it('keeps the heartbeat beating while the work continues', () => {
    const source = live(LIFECYCLE);
    // Anchor first: a rename or reformat of `onAbort` makes `indexOf` return -1, and an
    // unguarded `slice` then yields an empty body that passes `not.toContain('stop()')`
    // green — the guard would vanish silently (F-608). Fail loudly instead.
    const anchorAt = source.indexOf('function onAbort()');
    expect(anchorAt).toBeGreaterThan(-1);
    const onAbort = source.slice(anchorAt);
    const closeAt = onAbort.indexOf('\n  }');
    expect(closeAt).toBeGreaterThan(-1);
    const body = onAbort.slice(0, closeAt);
    // Stopping here is what made live work look stale to watchdog and reaper.
    expect(body).not.toContain('stop()');
  });

  it('never settles success over a reply that owed files', () => {
    const source = live(ROUTE);
    // A departed client skips the corrective ask, so "owed files" cannot be discharged:
    // classification must count the ask as spent, or a prose reply that claimed changes
    // fell through to succeedJob over an unchanged site.
    expect(source).toContain('askedAgain: askedForFilesAgain || clientDisconnected');
  });

  it('exits quietly when Stop settled the row in the settle window', () => {
    const source = live(ROUTE);
    // The persist-miss branch must not report a user cancel as "the workspace never
    // became ready", record a step failure, or track a generation failure for it.
    const anchorAt = source.indexOf("streamSettle?.outcome === 'failed'");
    expect(anchorAt).toBeGreaterThan(-1);
    const branch = source.slice(anchorAt, anchorAt + 1200);
    const cancelledGuardAt = branch.indexOf("streamSettle.errorCode === 'cancelled'");
    expect(cancelledGuardAt).toBeGreaterThan(-1);
    // The quiet exit comes before any persist-miss copy is composed.
    const persistMissAt = branch.indexOf('const persistMiss');
    expect(persistMissAt).toBeGreaterThan(cancelledGuardAt);
  });
});
