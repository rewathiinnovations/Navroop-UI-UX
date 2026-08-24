import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PROJECT_REQUIRED_MESSAGE,
  readGenerationProjectId,
} from '@/lib/generation/request-project';

// Newline-normalised: core.autocrlf=true gives these files CRLF in a fresh Windows
// checkout, and every multi-line probe below is written with `\n`.
const read = (rel: string) =>
  readFileSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), rel), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

const source = read('app/api/generate-ai-code-stream/route.ts');
/**
 * The guard sequence moved out of the route into `intakeGenerationRequest`. That is why
 * the ordering assertions below read this file rather than the route: "refuse for free
 * before you acquire" is now a property of a 190-line module instead of a convention
 * spanning a 2,200-line handler, and the route's own obligation shrank to one thing —
 * call intake before it acquires anything of its own.
 */
const intakeSource = read('lib/generation/intake.ts');

/**
 * F-035: with no project id the route ran a full build outside every control it has.
 * `Job.projectId` is a required FK, so no project meant no `Job` row, and everything that
 * meters a generation hangs off that row: the provider-queue slot (`AI_PROVIDER_CONCURRENCY`),
 * `markJobRunning`'s credit charge, `JobCapTracker`, `recordJobUsage`'s spend accrual, the
 * heartbeat, the progress batcher and the terminal settle. `checkCredits` ran and then
 * nothing debited it. A loop omitting one field therefore bought unlimited concurrent
 * generations that cost no credit, took no slot and accrued no spend.
 *
 * The product has no project-less entry point: `createProjectFromPrompt` POSTs `/api/projects`
 * and only then arms the build, and the route already refuses an unauthenticated request, so
 * the "signed-out PromptHero" run the finding hypothesises cannot reach it either. Metering a
 * project-less run would need a workspace-scoped job row that the schema cannot express and
 * nothing else in the product reads. So it is refused at the boundary, next to the prompt and
 * model checks, before anything is acquired.
 */
describe('readGenerationProjectId', () => {
  it('accepts the request project id, trimmed', () => {
    expect(readGenerationProjectId(' proj_1 ', undefined)).toEqual({
      ok: true,
      projectId: 'proj_1',
    });
  });

  it('falls back to the id inside the context object', () => {
    expect(readGenerationProjectId(undefined, 'proj_ctx')).toEqual({
      ok: true,
      projectId: 'proj_ctx',
    });
  });

  it('prefers the top-level id over the context copy', () => {
    expect(readGenerationProjectId('proj_top', 'proj_ctx')).toEqual({
      ok: true,
      projectId: 'proj_top',
    });
  });

  it('refuses a missing, blank or non-string id rather than running unmetered', () => {
    for (const value of [undefined, null, '', '   ', 42, {}, ['proj_1']]) {
      expect(readGenerationProjectId(value, undefined)).toEqual({
        ok: false,
        message: PROJECT_REQUIRED_MESSAGE,
      });
    }
  });

  it('falls through to the context id when the top-level one is unusable', () => {
    expect(readGenerationProjectId(42, ' proj_ctx ')).toEqual({ ok: true, projectId: 'proj_ctx' });
    expect(readGenerationProjectId('  ', 'proj_ctx')).toEqual({ ok: true, projectId: 'proj_ctx' });
  });
});

describe('generate-ai-code-stream refuses a project-less run (F-035)', () => {
  it('validates the project id before anything intake acquires', () => {
    const guardAt = intakeSource.indexOf('readGenerationProjectId(');
    expect(guardAt).toBeGreaterThan(0);
    for (const acquisition of ['await checkCredits(', 'await holdProjectLock(']) {
      expect(
        intakeSource.indexOf(acquisition),
        `${acquisition} must come after the project guard`,
      ).toBeGreaterThan(guardAt);
    }
  });

  it('clears intake before the route acquires the job row, the slot or the heartbeat', () => {
    // The rest of F-035's list stayed in the route, so the ordering claim splits in two:
    // intake refuses for free before it takes the lock (above), and the route does not
    // reach its own acquisitions until intake has returned ok.
    const intakeAt = source.indexOf('await intakeGenerationRequest(');
    expect(intakeAt).toBeGreaterThan(0);
    expect(source.indexOf('await request.json()')).toBeLessThan(intakeAt);
    for (const acquisition of [
      'await createOrReuseJob(',
      'getDefaultProviderQueue().acquire(',
      'beginJobHeartbeat(',
    ]) {
      expect(source.indexOf(acquisition), `${acquisition} must come after intake`).toBeGreaterThan(
        intakeAt,
      );
    }
    // And the refusal is returned rather than fallen through: nothing was acquired.
    expect(source).toMatch(/if \(!intake\.ok\) return intake\.response;/);
  });

  it('answers 400 with the boundary message', () => {
    const guardAt = intakeSource.indexOf('readGenerationProjectId(');
    const guard = intakeSource.slice(guardAt, guardAt + 400);
    expect(guard).toMatch(/status: 400/);
    expect(guard).toMatch(/projectCheck\.message/);
  });

  it('takes the lock and the job row unconditionally, so neither can be skipped again', () => {
    // Two-space indentation is intake's top level, four-space the handler's `try`:
    // neither statement sits inside an `if (projectId)` any more.
    expect(intakeSource).toMatch(
      /\n {2}const hold = await holdProjectLock\(projectId, sessionUser\.id, 'generation'\);/,
    );
    expect(source).toMatch(/\n {4}generationJob = await createOrReuseJob\(\{/);
    // The queue slot and the credit charge stay gated on the row's *status* — a reused
    // RUNNING job must not take a second slot — and on nothing else.
    expect(source).toMatch(/if \(generationJob\?\.status === 'QUEUED' && primaryProvider\) \{/);
    expect(source).not.toMatch(/generationJob = lockProjectId/);
    expect(source).not.toMatch(/if \(lockProjectId\)/);
  });

  it('meters the run against the one guarded project id', () => {
    // The lock, the Job row, the usage event and the conversation state each used to
    // re-derive `requestProjectId || context?.projectId`, so each was its own chance to
    // disagree about whether this run has a project. One resolution, read everywhere.
    expect(intakeSource).toMatch(/const projectId = projectCheck\.projectId;/);
    expect(intakeSource).toMatch(/holdProjectLock\(projectId, sessionUser\.id, 'generation'\)/);
    // One resolution, handed to the route rather than re-derived there.
    expect(intakeSource).toMatch(/return \{ ok: true, prompt, requestedModel, projectId,/);
    expect(source).toMatch(
      /const \{ prompt, requestedModel, projectId, sessionUser, hold \} = intake;/,
    );
    // Indentation-agnostic: prettier owns formatting here, so pinning the exact
    // six-space indent made this assert on a reflow rather than on the property,
    // which is that the metering call reads the one resolved id and the shared
    // workspace constant, adjacently.
    expect(source).toMatch(/^\s*projectId,\n\s*workspaceId: WORKSPACE_ROW_ID,/m);
    expect(source).toMatch(/const conversationProjectId = projectId;/);
    // The usage event is written for every run now, not only when an id happened to be
    // present, so a build's input tokens always have a GenerationEvent to land on.
    expect(source).not.toMatch(/usageProjectIdAtStart/);
  });
});
