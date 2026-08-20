import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PROJECT_REQUIRED_MESSAGE,
  readGenerationProjectId,
} from '@/lib/generation/request-project';

const routePath = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'app/api/generate-ai-code-stream/route.ts',
);
const source = readFileSync(routePath, 'utf8');

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
  it('validates the project id before anything is acquired', () => {
    const guardAt = source.indexOf('readGenerationProjectId(');
    expect(guardAt).toBeGreaterThan(0);
    expect(source.indexOf('await request.json()')).toBeLessThan(guardAt);
    for (const acquisition of [
      'await checkCredits(',
      'await holdProjectLock(',
      'await createOrReuseJob(',
      'getDefaultProviderQueue().acquire(',
      'beginJobHeartbeat(',
    ]) {
      expect(
        source.indexOf(acquisition),
        `${acquisition} must come after the project guard`,
      ).toBeGreaterThan(guardAt);
    }
  });

  it('answers 400 with the boundary message', () => {
    const guardAt = source.indexOf('readGenerationProjectId(');
    const guard = source.slice(guardAt, guardAt + 400);
    expect(guard).toMatch(/status: 400/);
    expect(guard).toMatch(/projectCheck\.message/);
  });

  it('takes the lock and the job row unconditionally, so neither can be skipped again', () => {
    // Four-space indentation is the top level of the handler's `try`: neither statement
    // sits inside an `if (projectId)` any more.
    expect(source).toMatch(
      /\n {4}const hold = await holdProjectLock\(projectId, sessionUser\.id, 'generation'\);/,
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
    expect(source).toMatch(/const projectId = projectCheck\.projectId;/);
    expect(source).toMatch(/holdProjectLock\(projectId, sessionUser\.id, 'generation'\)/);
    expect(source).toMatch(/\n {6}projectId,\n {6}workspaceId: WORKSPACE_ROW_ID,/);
    expect(source).toMatch(/const conversationProjectId = projectId;/);
    // The usage event is written for every run now, not only when an id happened to be
    // present, so a build's input tokens always have a GenerationEvent to land on.
    expect(source).not.toMatch(/usageProjectIdAtStart/);
  });
});
