import { prisma } from '@/lib/db';
import { stampActivePromptHash } from '@/lib/prompts/version';
import {
  a11yScoreFromAxe,
  buildSuccessScore,
  followupsToSettleScore,
  looksLikeVisualEdit,
  seoScoreFromFindings,
  typeSafetyScore,
  visualEditRateScore,
} from './score';

const BUILD_KINDS = ['initial', 'followup'] as const;
const SETTLE_MS = 30 * 60 * 1000;

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

function rawRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function hasSignal(where: {
  projectId: string;
  kind: string;
  generationEventId?: string | null;
  rawKey?: string;
  rawEquals?: unknown;
}) {
  const rows = await prisma.qualitySignal.findMany({
    where: {
      projectId: where.projectId,
      kind: where.kind,
      ...(where.generationEventId ? { generationEventId: where.generationEventId } : {}),
    },
    select: { id: true, rawValue: true, generationEventId: true },
  });
  if (where.rawKey) {
    return rows.find((row) => rawRecord(row.rawValue)[where.rawKey!] === where.rawEquals) ?? null;
  }
  return rows[0] ?? null;
}

/** Implicit: restore rejected the latest generation. */
export async function recordRevertRate(projectId: string, generationEventId?: string | null) {
  return withSignalGuard('revert_rate', async () => {
    const event = await signalSubject(projectId, generationEventId);
    if (event) {
      const existing = await hasSignal({
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

export async function maybeSettleFollowups(projectId: string, now = new Date()) {
  return withSignalGuard('followups_to_settle', async () => {
    const lastSettle = await prisma.qualitySignal.findFirst({
      where: { projectId, kind: 'followups_to_settle' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const after = lastSettle?.createdAt ?? new Date(0);
    const events = await prisma.generationEvent.findMany({
      where: {
        projectId,
        kind: { in: [...BUILD_KINDS] },
        createdAt: { gt: after },
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

    for (const event of events) {
      const existing = await hasSignal({
        projectId,
        kind: 'revert_rate',
        generationEventId: event.id,
      });
      if (existing) continue;
      await writeSignal({
        projectId,
        generationEventId: event.id,
        kind: 'revert_rate',
        value: 1,
        rawValue: { reverted: false, settled: true },
        promptVersion: event.promptVersion,
      });
    }

    return created;
  });
}

export async function settleIdleProjects(now = new Date()) {
  return withSignalGuard('settle_idle', async () => {
    const projects = await prisma.generationEvent.findMany({
      where: { kind: { in: [...BUILD_KINDS] } },
      distinct: ['projectId'],
      select: { projectId: true },
    });
    for (const row of projects) {
      await maybeSettleFollowups(row.projectId, now);
    }
    return projects.length;
  });
}

export async function recordVisualEditRate(
  projectId: string,
  visualEditCount: number,
  generationEventId?: string | null,
) {
  return withSignalGuard('visual_edit_rate', async () => {
    // Looked up, never fabricated: this branch used to invent
    // `{ id, promptVersion: null }` from the caller's id, and the null then sent
    // `writeSignal` to the active-version fallback.
    const event = await signalSubject(projectId, generationEventId);
    if (event?.id) {
      const existing = await hasSignal({
        projectId,
        kind: 'visual_edit_rate',
        generationEventId: event.id,
      });
      if (existing) return existing;
    }
    return writeSignal({
      projectId,
      generationEventId: event?.id ?? null,
      kind: 'visual_edit_rate',
      value: visualEditRateScore(visualEditCount),
      rawValue: { visualEditCount },
      promptVersion: event?.promptVersion,
    });
  });
}

export function countVisualEditsFromSource(source?: string | null, sourceMessage?: string | null) {
  if (source === 'visual-edit' || looksLikeVisualEdit(sourceMessage)) return 1;
  return 0;
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
      const existing = await hasSignal({
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
      const existing = await hasSignal({
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

export async function recordCodeAuditSignals(input: {
  projectId: string;
  codeAuditId?: string;
  metrics?: { tsErrors?: number; a11yViolations?: number };
  axeViolations?: Array<{ impact?: string | null }>;
  buildOk?: boolean;
}) {
  return withSignalGuard('code_audit', async () => {
    const event = await latestBuildEvent(input.projectId);
    const promptVersion = event?.promptVersion ?? (await stampActivePromptHash());
    const created: string[] = [];

    if (input.axeViolations || input.metrics?.a11yViolations != null) {
      if (
        !input.codeAuditId ||
        !(await hasSignal({
          projectId: input.projectId,
          kind: 'a11y_score',
          rawKey: 'codeAuditId',
          rawEquals: input.codeAuditId,
        }))
      ) {
        const violations =
          input.axeViolations ??
          Array.from({ length: input.metrics?.a11yViolations ?? 0 }, () => ({
            impact: 'moderate',
          }));
        await writeSignal({
          projectId: input.projectId,
          generationEventId: event?.id ?? null,
          kind: 'a11y_score',
          value: a11yScoreFromAxe(violations),
          rawValue: {
            codeAuditId: input.codeAuditId ?? null,
            violations: input.axeViolations?.length ?? input.metrics?.a11yViolations ?? 0,
          },
          promptVersion,
        });
        created.push('a11y_score');
      }
    }

    if (input.buildOk != null) {
      if (
        !input.codeAuditId ||
        !(await hasSignal({
          projectId: input.projectId,
          kind: 'build_success',
          rawKey: 'codeAuditId',
          rawEquals: input.codeAuditId,
        }))
      ) {
        await writeSignal({
          projectId: input.projectId,
          generationEventId: event?.id ?? null,
          kind: 'build_success',
          value: buildSuccessScore(input.buildOk),
          rawValue: { codeAuditId: input.codeAuditId ?? null, buildOk: input.buildOk },
          promptVersion,
        });
        created.push('build_success');
      }
    }

    if (input.metrics?.tsErrors != null) {
      if (
        !input.codeAuditId ||
        !(await hasSignal({
          projectId: input.projectId,
          kind: 'type_safety',
          rawKey: 'codeAuditId',
          rawEquals: input.codeAuditId,
        }))
      ) {
        await writeSignal({
          projectId: input.projectId,
          generationEventId: event?.id ?? null,
          kind: 'type_safety',
          value: typeSafetyScore(input.metrics.tsErrors),
          rawValue: { codeAuditId: input.codeAuditId ?? null, tsErrors: input.metrics.tsErrors },
          promptVersion,
        });
        created.push('type_safety');
      }
    }

    return created;
  });
}
