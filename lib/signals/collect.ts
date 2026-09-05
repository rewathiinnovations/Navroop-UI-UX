import { prisma } from '@/lib/db';
import { stampActivePromptHash } from '@/lib/prompts/version';
import {
  RUNTIME_ERRORS_KIND,
  TOOL_REFUSAL_KIND_PREFIX,
  a11yScoreFromAxe,
  buildSuccessScore,
  followupsToSettleScore,
  runtimeErrorScore,
  seoScoreFromFindings,
  toolRefusalKind,
  typeSafetyScore,
} from './score';

const BUILD_KINDS = ['initial', 'followup'] as const;
const SETTLE_MS = 30 * 60 * 1000;
/** Older than this and a project was either settled long ago or never will be. */
const SETTLE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const SETTLE_BATCH = 100;
const SETTLE_CONCURRENCY = 5;

export async function withSignalGuard<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[signals] ${label} failed`, error);
    return null;
  }
}

async function latestBuildEvent(projectId: string) {
  return prisma.generationEvent.findFirst({
    where: { projectId, kind: { in: [...BUILD_KINDS] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, promptVersion: true, createdAt: true },
  });
}

/**
 * `promptVersion` is the version of the generation the signal is about.
 *
 * The `stampActivePromptHash` fallback is a last resort for a signal with no
 * generation behind it at all — never a substitute for a version the caller
 * could have looked up. `recordThumbs` and `recordRevertRate` used to hit it on
 * every call because they kept only the event's `id`, so a thumbs-down on v2's
 * output was filed against whatever was active when the user clicked, and
 * /admin/quality's per-version comparison attributed old failures to the new
 * prompt (F-815).
 */
async function writeSignal(data: {
  projectId: string;
  generationEventId?: string | null;
  kind: string;
  value: number;
  rawValue?: unknown;
  promptVersion?: string | null;
}) {
  const promptVersion = data.promptVersion || (await stampActivePromptHash());
  return prisma.qualitySignal.create({
    data: {
      projectId: data.projectId,
      generationEventId: data.generationEventId ?? null,
      kind: data.kind,
      value: data.value,
      rawValue: data.rawValue === undefined ? undefined : (data.rawValue as object),
      promptVersion,
    },
  });
}

/**
 * The generation a signal is about: the one named, or the project's latest
 * build. Returns its `promptVersion` as well as its id — the whole point of
 * looking it up rather than trusting the caller's bare id.
 */
async function signalSubject(projectId: string, generationEventId?: string | null) {
  if (generationEventId) {
    return prisma.generationEvent.findUnique({
      where: { id: generationEventId },
      select: { id: true, promptVersion: true },
    });
  }
  return latestBuildEvent(projectId);
}

/**
 * One indexed lookup, not a scan.
 *
 * This used to `findMany` every `QualitySignal` row for `(projectId, kind)`
 * with no `take`, ship each row's `rawValue` to Node and filter there — and it
 * is called once per event inside `maybeSettleFollowups`'s loop, so a project's
 * entire revert history was re-read for every unsettled generation: O(N²) reads
 * for N generations (F-817). The `rawKey` variant now filters the JSON column
 * server-side.
 */
async function findSignal(where: {
  projectId: string;
  kind: string;
  generationEventId?: string | null;
  rawKey?: string;
  rawEquals?: string;
}) {
  return prisma.qualitySignal.findFirst({
    where: {
      projectId: where.projectId,
      kind: where.kind,
      ...(where.generationEventId ? { generationEventId: where.generationEventId } : {}),
      ...(where.rawKey ? { rawValue: { path: [where.rawKey], equals: where.rawEquals } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
}

/** Implicit: restore rejected the latest generation. */
export async function recordRevertRate(projectId: string, generationEventId?: string | null) {
  return withSignalGuard('revert_rate', async () => {
    const event = await signalSubject(projectId, generationEventId);
    if (event) {
      const existing = await findSignal({
        projectId,
        kind: 'revert_rate',
        generationEventId: event.id,
      });
      if (existing) {
        return prisma.qualitySignal.update({
          where: { id: existing.id },
          data: {
            value: 0,
            rawValue: { reverted: true },
            // Repairs a row `maybeSettleFollowups` — or the old code — stamped
            // with a different version than the generation it belongs to.
            ...(event.promptVersion ? { promptVersion: event.promptVersion } : {}),
          },
        });
      }
    }
    return writeSignal({
      projectId,
      generationEventId: event?.id ?? null,
      kind: 'revert_rate',
      value: 0,
      rawValue: { reverted: true },
      promptVersion: event?.promptVersion,
    });
  });
}

/**
 * The other half of `revert_rate`, written when a generation succeeds.
 *
 * `recordRevertRate` wrote a `0` on every restore immediately, but the compensating `1`
 * for a generation nobody reverted came only from `maybeSettleFollowups`, and only once
 * 30 minutes had passed since the project's last build. A project under active iteration
 * never satisfies that, so the projects producing the most signal contributed all zeros
 * and no ones and the aggregate read as though every generation had been rejected — the
 * metric was biased against whichever prompt version was active during heavy use (F-818).
 *
 * Writing the `1` here makes the population complete from the first build; a later restore
 * flips this row to `0` through `recordRevertRate`'s update branch. The existing-row check
 * keeps it idempotent, so a retried persist or a settle sweep cannot double-count.
 */
export async function recordGenerationKept(projectId: string, generationEventId?: string | null) {
  return withSignalGuard('revert_rate', async () => {
    const event = await signalSubject(projectId, generationEventId);
    if (!event) return null;
    const existing = await findSignal({
      projectId,
      kind: 'revert_rate',
      generationEventId: event.id,
    });
    // Already decided: either a restore recorded the revert, or a settle already paired it.
    if (existing) return null;
    return writeSignal({
      projectId,
      generationEventId: event.id,
      kind: 'revert_rate',
      value: 1,
      rawValue: { reverted: false, kept: true },
      promptVersion: event.promptVersion,
    });
  });
}

/**
 * The event ids a previous `followups_to_settle` row already counted, read back out of its
 * `rawValue`. Used as the tiebreak for the `gte` cursor above: the timestamp alone cannot
 * distinguish "the boundary event was counted" from "it was written in the same
 * millisecond and skipped".
 */
function settledEventIds(rawValue: unknown): string[] {
  if (!rawValue || typeof rawValue !== 'object' || !('eventIds' in rawValue)) return [];
  const ids = rawValue.eventIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}

export async function maybeSettleFollowups(projectId: string, now = new Date()) {
  return withSignalGuard('followups_to_settle', async () => {
    const lastSettle = await prisma.qualitySignal.findFirst({
      where: { projectId, kind: 'followups_to_settle' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, rawValue: true },
    });
    const after = lastSettle?.createdAt ?? new Date(0);
    // `gt: after` dropped, permanently, any event whose `createdAt` equalled the settle
    // row's to the millisecond — it was never counted and never got its paired
    // `revert_rate` (F-818). `gte` re-admits that boundary; the previous batch records its
    // own event ids in `rawValue.eventIds`, and excluding those is what keeps the
    // re-admitted boundary from being counted twice.
    const alreadySettled = settledEventIds(lastSettle?.rawValue);
    const events = await prisma.generationEvent.findMany({
      where: {
        projectId,
        kind: { in: [...BUILD_KINDS] },
        createdAt: { gte: after },
        ...(alreadySettled.length > 0 ? { id: { notIn: alreadySettled } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, promptVersion: true },
    });
    if (events.length === 0) return null;
    const last = events[events.length - 1];
    if (now.getTime() - last.createdAt.getTime() < SETTLE_MS) return null;

    const created = await writeSignal({
      projectId,
      generationEventId: last.id,
      kind: 'followups_to_settle',
      value: followupsToSettleScore(events.length),
      rawValue: { generations: events.length, eventIds: events.map((event) => event.id) },
      promptVersion: last.promptVersion,
    });

    // One lookup for the whole batch, then one insert. The old loop ran a
    // whole-history scan plus a create per event — 2N round trips for N
    // unsettled generations (F-817).
    const settled = await prisma.qualitySignal.findMany({
      where: {
        projectId,
        kind: 'revert_rate',
        generationEventId: { in: events.map((event) => event.id) },
      },
      select: { generationEventId: true },
    });
    const settledIds = new Set(settled.map((row) => row.generationEventId));
    const pending = events.filter((event) => !settledIds.has(event.id));
    if (pending.length > 0) {
      // `promptVersion` is required by the schema, so an event that never
      // carried one still needs a stamp — read once for the batch, not per row.
      const fallback = pending.every((event) => event.promptVersion)
        ? ''
        : await stampActivePromptHash();
      await prisma.qualitySignal.createMany({
        data: pending.map((event) => ({
          projectId,
          generationEventId: event.id,
          kind: 'revert_rate',
          value: 1,
          rawValue: { reverted: false, settled: true },
          promptVersion: event.promptVersion || fallback,
        })),
      });
    }

    return created;
  });
}

/**
 * Safety net for projects whose per-generation settle never ran — the call in
 * `lib/projects/actions.ts` is detached, so a crash drops it.
 *
 * Bounded on both axes: only projects whose last build is inside the lookback
 * and already past the settle window, and at most `SETTLE_BATCH` of them per
 * run, in small concurrent groups. It used to read every `GenerationEvent` ever
 * written with no date bound and no `take`, then await one settle per project
 * in series — and it ran as the first statement of the `/admin/quality` render
 * (F-817, F-732). It is now a cron job (daily thin-checkpoints).
 */
export async function settleIdleProjects(now = new Date(), limit = SETTLE_BATCH) {
  return withSignalGuard('settle_idle', async () => {
    const groups = await prisma.generationEvent.groupBy({
      by: ['projectId'],
      where: {
        kind: { in: [...BUILD_KINDS] },
        createdAt: { gte: new Date(now.getTime() - SETTLE_LOOKBACK_MS) },
      },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take: limit,
    });
    // A project whose newest build is younger than the settle window cannot
    // settle yet; filtering here saves `maybeSettleFollowups` two queries each.
    const due = groups.filter(
      (row) =>
        row._max.createdAt != null && now.getTime() - row._max.createdAt.getTime() >= SETTLE_MS,
    );
    for (let index = 0; index < due.length; index += SETTLE_CONCURRENCY) {
      await Promise.all(
        due
          .slice(index, index + SETTLE_CONCURRENCY)
          .map((row) => maybeSettleFollowups(row.projectId, now)),
      );
    }
    return due.length;
  });
}

/*
 * `recordVisualEditRate` / `countVisualEditsFromSource` were removed on
 * 2026-09-05 along with the `visual_edit_rate` weight. Visual edits went on
 * 2026-08-28, so the count was structurally always 0 and the signal recorded a
 * perfect 1.0 for every project forever. Existing `QualitySignal` rows of that
 * kind are left in place — `kind` is a plain string column and
 * `composeOverallScore` iterates the weights, so rows nothing weights are
 * simply never read.
 */

/** Per-tool `{ phase: 'result' }` counts for one generation. */
export type ToolResultTally = Record<string, { results: number; refusals: number }>;

/**
 * Counts one tool result into a run's tally.
 *
 * Lives here rather than inline in the generate route so the rule for what
 * counts is in the same module as the writer that reads it: only `result`
 * events, one per returned tool call, and a refusal is a result the tool
 * returned with `ok: false` — never a thrown error. The tools return their
 * refusals on purpose (see `lib/generation/tools/index.ts`), so a run with a
 * high refusal rate is a run the model kept correcting itself through, not a run
 * that crashed.
 */
export function countToolResult(tally: ToolResultTally, tool: string, ok: boolean) {
  const counts = (tally[tool] ??= { results: 0, refusals: 0 });
  counts.results += 1;
  if (!ok) counts.refusals += 1;
  return tally;
}

/**
 * What fraction of this generation's tool calls each tool refused.
 *
 * The tool surface is the product's only view of what the model actually tried
 * to do, and the refusals were visible in the SSE stream and nowhere else: they
 * reached the browser as `tool_result` frames, were rendered once, and were
 * gone. A prompt change that makes the model guess at paths, or reach for
 * packages the preview cannot serve, shows up here a long time before it shows
 * up in `revert_rate` — which needs a user to notice and restore.
 *
 * One row per tool per generation, keyed to the generation's own
 * `promptVersion` (not the active one — see `writeSignal`), so "did v3 make the
 * model fight `edit_file`" is a `groupBy` and not a log grep. `value` is the
 * refusal rate, so higher is worse; it is deliberately outside
 * `QUALITY_SIGNAL_KINDS` and the weighted composite (see
 * `TOOL_REFUSAL_KIND_PREFIX`).
 *
 * Idempotent on the generation event: a retried record must not double a run's
 * contribution to the population, and unlike the other collectors there is no
 * single kind to look for, so the check is on the namespace.
 */
export async function recordToolRefusalRates(
  projectId: string,
  tally: ToolResultTally,
  generationEventId?: string | null,
) {
  return withSignalGuard('tool_refusal_rate', async () => {
    const tools = Object.entries(tally).filter(([, counts]) => counts.results > 0);
    if (tools.length === 0) return null;
    const event = await signalSubject(projectId, generationEventId);
    if (event) {
      const existing = await prisma.qualitySignal.findFirst({
        where: {
          projectId,
          generationEventId: event.id,
          kind: { startsWith: TOOL_REFUSAL_KIND_PREFIX },
        },
        select: { id: true },
      });
      if (existing) return null;
    }
    const promptVersion = event?.promptVersion || (await stampActivePromptHash());
    // One insert for the whole run: a generation calls six tools and the loop
    // form would be six round trips on the tail of a request the user is already
    // waiting on.
    await prisma.qualitySignal.createMany({
      data: tools.map(([tool, counts]) => ({
        projectId,
        generationEventId: event?.id ?? null,
        kind: toolRefusalKind(tool),
        value: counts.refusals / counts.results,
        // Both counts, not just the rate: 1/1 and 40/40 are the same rate and
        // very different runs, and the mean over rows cannot tell them apart.
        rawValue: { tool, results: counts.results, refusals: counts.refusals },
        promptVersion,
      })),
    });
    return tools.length;
  });
}

export async function recordThumbs(
  projectId: string,
  rating: 'up' | 'down',
  generationEventId?: string | null,
) {
  return withSignalGuard('thumbs', async () => {
    const event = await signalSubject(projectId, generationEventId);
    const value = rating === 'up' ? 1 : 0;
    if (event) {
      const existing = await findSignal({
        projectId,
        kind: 'thumbs',
        generationEventId: event.id,
      });
      if (existing) {
        return prisma.qualitySignal.update({
          where: { id: existing.id },
          data: {
            value,
            rawValue: { rating },
            // A rating changed later is still about the same generation, so the
            // stamp is corrected rather than left on whatever was active before.
            ...(event.promptVersion ? { promptVersion: event.promptVersion } : {}),
          },
        });
      }
    }
    return writeSignal({
      projectId,
      generationEventId: event?.id ?? null,
      kind: 'thumbs',
      value,
      rawValue: { rating },
      promptVersion: event?.promptVersion,
    });
  });
}

export async function recordSeoScore(
  projectId: string,
  findings: Array<{ status?: string; ignored?: boolean }>,
  seoAuditId?: string,
) {
  return withSignalGuard('seo_score', async () => {
    if (seoAuditId) {
      const existing = await findSignal({
        projectId,
        kind: 'seo_score',
        rawKey: 'seoAuditId',
        rawEquals: seoAuditId,
      });
      if (existing) return existing;
    }
    const event = await latestBuildEvent(projectId);
    return writeSignal({
      projectId,
      generationEventId: event?.id ?? null,
      kind: 'seo_score',
      value: seoScoreFromFindings(findings),
      rawValue: {
        seoAuditId: seoAuditId ?? null,
        applicable: findings.filter((row) => !row.ignored).length,
      },
      promptVersion: event?.promptVersion,
    });
  });
}

/**
 * Every measurement is tri-state: a value, or `null`/absent for "that check did
 * not run". A check that did not run records nothing.
 *
 * It used to record a perfect score instead. `a11yViolations` and `tsErrors`
 * are counts derived from the findings list, and a tool that could not start
 * contributes no findings — so a project whose type-check never executed was
 * filed as 0 errors → 1.0, and a page axe could not reach as 0 violations → 1.0
 * (F-705). The a11y branch went further and *fabricated* the impacts —
 * `Array.from({ length: n }, () => ({ impact: 'moderate' }))` — so
 * `a11yScoreFromAxe`'s impact weighting scored two critical violations exactly
 * like two moderate ones (F-816). Real impacts now come from the axe findings
 * themselves; there is no synthesised path left.
 */
export type CodeAuditSignalInput = {
  projectId: string;
  codeAuditId?: string;
  /** `[]` = axe ran and the page was clean; `null` = axe did not run. */
  axeViolations?: Array<{ impact?: string | null }> | null;
  /** `null` = the type-checker did not run. */
  tsErrors?: number | null;
  /** `null` = no production build was attempted. */
  buildOk?: boolean | null;
  /**
   * `0` = a page loaded and threw nothing; `null` = no page was ever opened.
   *
   * The distinction is the whole point, as with `axeViolations`: a scan where Chromium was
   * unavailable must not read as a clean site (F-705).
   */
  runtimeErrors?: number | null;
};

export async function recordCodeAuditSignals(input: CodeAuditSignalInput) {
  return withSignalGuard('code_audit', async () => {
    const event = await latestBuildEvent(input.projectId);
    const promptVersion = event?.promptVersion ?? (await stampActivePromptHash());
    const created: string[] = [];

    const record = async (kind: string, value: number, rawValue: Record<string, unknown>) => {
      const duplicate =
        input.codeAuditId &&
        (await findSignal({
          projectId: input.projectId,
          kind,
          rawKey: 'codeAuditId',
          rawEquals: input.codeAuditId,
        }));
      if (duplicate) return;
      await writeSignal({
        projectId: input.projectId,
        generationEventId: event?.id ?? null,
        kind,
        value,
        rawValue: { codeAuditId: input.codeAuditId ?? null, ...rawValue },
        promptVersion,
      });
      created.push(kind);
    };

    if (input.axeViolations != null) {
      await record('a11y_score', a11yScoreFromAxe(input.axeViolations), {
        violations: input.axeViolations.length,
        // Kept so the score can be re-derived from the row: a count alone
        // cannot distinguish the run this signal came from.
        impacts: input.axeViolations.map((row) => row.impact ?? null),
      });
    }

    if (input.buildOk != null) {
      await record('build_success', buildSuccessScore(input.buildOk), { buildOk: input.buildOk });
    }

    if (input.tsErrors != null) {
      await record('type_safety', typeSafetyScore(input.tsErrors), { tsErrors: input.tsErrors });
    }

    if (input.runtimeErrors != null) {
      await record(RUNTIME_ERRORS_KIND, runtimeErrorScore(input.runtimeErrors), {
        runtimeErrors: input.runtimeErrors,
      });
    }

    return created;
  });
}
