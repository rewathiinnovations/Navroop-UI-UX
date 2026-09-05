/**
 * One-off: populate QualitySignals from historical restores, audits, and generations.
 * Stamps promptVersion "v1 baseline". Idempotent — second run creates no duplicates.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/backfill-quality-signals.ts
 */
import { config } from 'dotenv';
import { prisma } from '../lib/db';
import {
  a11yScoreFromAxe,
  buildSuccessScore,
  followupsToSettleScore,
  seoScoreFromFindings,
  typeSafetyScore,
} from '../lib/signals/score';
import {
  BASELINE_PROMPT_LABEL,
  assembleVersionedPrefix,
  hashPromptPrefix,
} from '../lib/prompts/version';
import { DESIGN_DIRECTION_IDS } from '../lib/design/directions';
import { STACK_IDS } from '../lib/stacks';
import { MEMORY_CATEGORIES, MEMORY_TOKEN_BUDGET } from '../lib/memory/types';

config({ path: '.env' });
config({ path: '.env.local', override: true });
const BUILD_KINDS = ['initial', 'followup'];
const SETTLE_MS = 30 * 60 * 1000;

function rawRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

async function main() {
  const hash = hashPromptPrefix(assembleVersionedPrefix());
  const version =
    (await prisma.promptVersion.findUnique({ where: { hash } })) ??
    (await prisma.promptVersion.create({
      data: {
        hash,
        label: BASELINE_PROMPT_LABEL,
        config: {
          stacks: [...STACK_IDS],
          directions: [...DESIGN_DIRECTION_IDS],
          memorySlot: { categories: [...MEMORY_CATEGORIES], tokenBudget: MEMORY_TOKEN_BUDGET },
          seed: BASELINE_PROMPT_LABEL,
        },
        isActive: true,
      },
    }));

  if (!version.isActive) {
    await prisma.promptVersion.updateMany({ data: { isActive: false } });
    await prisma.promptVersion.update({ where: { id: version.id }, data: { isActive: true } });
  }

  const stamped = await prisma.generationEvent.updateMany({
    where: { promptVersion: null },
    data: { promptVersion: hash },
  });

  const existing = await prisma.qualitySignal.findMany({
    select: { projectId: true, kind: true, generationEventId: true, rawValue: true },
  });

  const has = (kind: string, key: string, value: unknown) =>
    existing.some((row) => row.kind === kind && rawRecord(row.rawValue)[key] === value);
  const hasEvent = (kind: string, eventId: string | null) =>
    Boolean(eventId) &&
    existing.some((row) => row.kind === kind && row.generationEventId === eventId);

  const created: string[] = [];

  async function emit(data: {
    projectId: string;
    generationEventId?: string | null;
    kind: string;
    value: number;
    rawValue: unknown;
  }) {
    const row = await prisma.qualitySignal.create({
      data: {
        projectId: data.projectId,
        generationEventId: data.generationEventId ?? null,
        kind: data.kind,
        value: data.value,
        rawValue: data.rawValue as object,
        promptVersion: hash,
      },
    });
    existing.push({
      projectId: row.projectId,
      kind: row.kind,
      generationEventId: row.generationEventId,
      rawValue: row.rawValue,
    });
    created.push(data.kind);
  }

  const restores = await prisma.checkpoint.findMany({
    where: { trigger: 'restore' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, projectId: true, createdAt: true },
  });
  for (const restore of restores) {
    if (has('revert_rate', 'checkpointId', restore.id)) continue;
    const event = await prisma.generationEvent.findFirst({
      where: {
        projectId: restore.projectId,
        kind: { in: BUILD_KINDS },
        createdAt: { lt: restore.createdAt },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await emit({
      projectId: restore.projectId,
      generationEventId: event?.id ?? null,
      kind: 'revert_rate',
      value: 0,
      rawValue: { reverted: true, checkpointId: restore.id, backfill: true },
    });
  }

  const seoAudits = await prisma.seoAudit.findMany({
    select: { id: true, projectId: true, findings: true, scannedAt: true },
  });
  for (const audit of seoAudits) {
    if (has('seo_score', 'seoAuditId', audit.id)) continue;
    const findings = Array.isArray(audit.findings)
      ? (audit.findings as Array<{ status?: string; ignored?: boolean }>)
      : [];
    const event = await prisma.generationEvent.findFirst({
      where: {
        projectId: audit.projectId,
        kind: { in: BUILD_KINDS },
        createdAt: { lte: audit.scannedAt },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await emit({
      projectId: audit.projectId,
      generationEventId: event?.id ?? null,
      kind: 'seo_score',
      value: seoScoreFromFindings(findings),
      rawValue: { seoAuditId: audit.id, backfill: true },
    });
  }

  const codeAudits = await prisma.codeAudit.findMany({
    select: { id: true, projectId: true, findings: true, metrics: true, scannedAt: true },
  });
  for (const audit of codeAudits) {
    const metrics = (audit.metrics || {}) as { tsErrors?: number; a11yViolations?: number };
    const findings = Array.isArray(audit.findings)
      ? (audit.findings as Array<{ id?: string }>)
      : [];
    const event = await prisma.generationEvent.findFirst({
      where: {
        projectId: audit.projectId,
        kind: { in: BUILD_KINDS },
        createdAt: { lte: audit.scannedAt },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!has('a11y_score', 'codeAuditId', audit.id)) {
      const count = typeof metrics.a11yViolations === 'number' ? metrics.a11yViolations : 0;
      await emit({
        projectId: audit.projectId,
        generationEventId: event?.id ?? null,
        kind: 'a11y_score',
        value: a11yScoreFromAxe(Array.from({ length: count }, () => ({ impact: 'moderate' }))),
        rawValue: { codeAuditId: audit.id, violations: count, backfill: true },
      });
    }
    if (!has('build_success', 'codeAuditId', audit.id)) {
      const buildOk = !findings.some((item) => item.id === 'bundle:build-failed');
      await emit({
        projectId: audit.projectId,
        generationEventId: event?.id ?? null,
        kind: 'build_success',
        value: buildSuccessScore(buildOk),
        rawValue: { codeAuditId: audit.id, buildOk, backfill: true },
      });
    }
    if (!has('type_safety', 'codeAuditId', audit.id)) {
      const tsErrors = typeof metrics.tsErrors === 'number' ? metrics.tsErrors : 0;
      await emit({
        projectId: audit.projectId,
        generationEventId: event?.id ?? null,
        kind: 'type_safety',
        value: typeSafetyScore(tsErrors),
        rawValue: { codeAuditId: audit.id, tsErrors, backfill: true },
      });
    }
  }

  const projects = await prisma.generationEvent.findMany({
    where: { kind: { in: BUILD_KINDS } },
    distinct: ['projectId'],
    select: { projectId: true },
  });
  const now = Date.now();
  for (const { projectId } of projects) {
    const events = await prisma.generationEvent.findMany({
      where: { projectId, kind: { in: BUILD_KINDS } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true },
    });
    let windowStart = 0;
    for (let i = 0; i < events.length; i += 1) {
      const next = events[i + 1];
      const gap = next
        ? next.createdAt.getTime() - events[i].createdAt.getTime()
        : now - events[i].createdAt.getTime();
      if (gap < SETTLE_MS) continue;
      const slice = events.slice(windowStart, i + 1);
      windowStart = i + 1;
      if (slice.length === 0) continue;
      const last = slice[slice.length - 1];
      if (
        has('followups_to_settle', 'eventIds', last.id) ||
        hasEvent('followups_to_settle', last.id)
      )
        continue;
      await emit({
        projectId,
        generationEventId: last.id,
        kind: 'followups_to_settle',
        value: followupsToSettleScore(slice.length),
        rawValue: { generations: slice.length, eventIds: last.id, backfill: true },
      });
      for (const event of slice) {
        if (hasEvent('revert_rate', event.id)) continue;
        await emit({
          projectId,
          generationEventId: event.id,
          kind: 'revert_rate',
          value: 1,
          rawValue: { reverted: false, settled: true, backfill: true },
        });
      }
    }

    // The `visual_edit_rate` backfill was removed on 2026-09-05 with the signal
    // itself: visual edits went on 2026-08-28, so `looksLikeVisualEdit` matched
    // nothing and this loop wrote a perfect 1.0 onto every historical event.
    // Backfilling a kind no weight reads would only add rows nothing scores.
  }

  console.log(
    JSON.stringify(
      {
        promptVersion: version.label,
        hash,
        stampedEvents: stamped.count,
        newSignals: created.length,
        byKind: created.reduce<Record<string, number>>((acc, kind) => {
          acc[kind] = (acc[kind] || 0) + 1;
          return acc;
        }, {}),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
