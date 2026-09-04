'use client';

import {
  AlertCircle,
  Coins,
  FolderOpen,
  Gauge,
  GitCommitHorizontal,
  Sparkles,
  Wrench,
} from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import { AdminTable, Td, Th, Tr } from '@/components/admin/AdminTable';
import StatTile from '@/components/admin/StatTile';
import StatusBanner from '@/components/admin/StatusBanner';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import {
  MIN_KIND_SAMPLES,
  QUALITY_SIGNAL_KINDS,
  type QualitySignalKind,
} from '@/lib/signals/score';
import { formatAdminDate } from '../format-admin-date';
import { handleAdminForbidden } from '@/lib/admin/forbidden';
import { toMessage } from '@/lib/notify';

type KindMetric = {
  kind: QualitySignalKind;
  label: string;
  definition: string;
  mean: number | null;
  n: number;
  trend: number | null;
};

type RecurringIssue = {
  category: string;
  count: number;
  sampleTitle: string;
};

type VersionRow = {
  id: string;
  hash: string;
  label: string;
  isActive: boolean;
  createdAt: string;
  overall: number | null;
  sampleCount: number;
  metrics: Record<string, KindMetric>;
};

type ToolRefusalRow = {
  tool: string;
  rate: number | null;
  n: number;
};

type CostRow = {
  promptVersion: string | null;
  label: string;
  events: number;
  estimatedCostUsd: number;
  inputTokens: number;
  costPerEventUsd: number | null;
  tokensPerEvent: number | null;
};

type Dashboard = {
  summary: {
    totalGenerations: number;
    activeDays: number;
    promptVersionLabel: string;
  };
  metrics: Record<QualitySignalKind, KindMetric>;
  overall: number | null;
  versions: VersionRow[];
  toolRefusals: ToolRefusalRow[];
  costs: CostRow[];
  recurringIssues: RecurringIssue[];
};

function last30DayInputs(now = new Date()) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  const fmt = (date: Date) => date.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

/**
 * Three scores were hidden in Wave 2 because the collectors recorded a perfect
 * 1.0 for checks that never ran (F-705).
 *
 * `a11y_score` is back: axe really runs, in a headless browser against the
 * preview, and the collector now records the run's own impacts instead of
 * inventing "moderate" for each violation (F-816). A run axe could not start
 * records nothing at all rather than 1.0.
 *
 * `type_safety` and `build_success` stay hidden, and it is not the collector's
 * fault any more: nothing executes `tsc` or a production build. Both needed the
 * sandbox that no longer exists, so the honest state is no samples — and the
 * rows already in the table for them are the fabricated 1.0s, which is the
 * second reason not to chart them. Un-hide either one when something actually
 * runs it.
 */
const BROKEN_SIGNAL_KINDS: Partial<Record<QualitySignalKind, true>> = {
  type_safety: true,
  build_success: true,
};
const SHOWN_SIGNAL_KINDS = QUALITY_SIGNAL_KINDS.filter((kind) => !BROKEN_SIGNAL_KINDS[kind]);

function formatPct(value: number) {
  return `${Math.round(value * 1000) / 10}%`;
}

/**
 * Four decimals under a cent, two above.
 *
 * `GenerationEvent.estimatedCost` is a `Decimal(10, 4)` and one follow-up
 * usually prices well under a cent, so the two-decimal money format the rest of
 * the admin surface uses renders a whole prompt version's per-generation cost as
 * `$0.00` — the exact comparison this panel exists to make, printed as a tie.
 */
function formatUsd(value: number) {
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function trendLabel(trend: number | null) {
  if (trend == null) return '—';
  const pct = Math.round(trend * 1000) / 10;
  if (pct > 0) return `↑ ${pct} pts`;
  if (pct < 0) return `↓ ${Math.abs(pct)} pts`;
  return '→ 0';
}

export default function QualityDashboard() {
  const router = useRouter();
  const defaults = useMemo(() => last30DayInputs(), []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [applied, setApplied] = useState(defaults);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const query = `from=${encodeURIComponent(applied.from)}&to=${encodeURIComponent(applied.to)}`;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(`/api/admin/quality?${query}`);
        if (response.status === 403) {
          handleAdminForbidden(router);
          return;
        }
        const payload = await response.json();
        if (!response.ok) {
          if (!cancelled) setError(payload.error || 'Could not load quality');
          return;
        }
        if (!cancelled) setData(payload);
      } catch (cause) {
        if (!cancelled) setError(toMessage(cause, 'Could not load quality'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [query, router]);

  const applyRange = (event: FormEvent) => {
    event.preventDefault();
    setApplied({ from, to });
  };

  return (
    <AdminPage
      icon="quality"
      title="Quality"
      description="How well generation is performing over time, and the problems that keep recurring."
      width="wide"
      actions={
        <form onSubmit={applyRange} className="flex flex-wrap items-end gap-8">
          <StudioField
            id="quality-from"
            label="From"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            required
          />
          <StudioField
            id="quality-to"
            label="To"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            required
          />
          <StudioButton type="submit" variant="ghost" disabled={loading}>
            Apply
          </StudioButton>
        </form>
      }
    >
      {error && <StatusBanner tone="error">{error}</StatusBanner>}

      <div className="grid grid-cols-1 gap-12 sm:grid-cols-3">
        <StatTile
          icon={<FolderOpen className="size-16" aria-hidden />}
          value={data ? data.summary.totalGenerations : '—'}
          label="Generations"
        />
        <StatTile
          icon={<Gauge className="size-16" aria-hidden />}
          value={data ? data.summary.activeDays : '—'}
          label="Active days"
        />
        <StatTile
          icon={<GitCommitHorizontal className="size-16" aria-hidden />}
          value={data?.summary.promptVersionLabel || '—'}
          label="Prompt version"
        />
      </div>

      <AdminCard
        icon={<Sparkles className="size-14" aria-hidden />}
        title="Signal scores"
        description={
          data?.overall != null
            ? `Overall quality score ${formatPct(data.overall)} — weighted composite, shown only with 30+ samples.`
            : undefined
        }
      >
        <p className="mb-12 text-[12px] text-[var(--studio-muted)]">
          Type safety and build success are hidden: nothing runs a type-check or a production build
          for a project, so there is nothing honest to show. Accessibility is measured by axe
          against the preview and is shown; a run axe could not complete records no score rather
          than a perfect one.
        </p>
        <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-4">
          {SHOWN_SIGNAL_KINDS.map((kind) => {
            const metric = data?.metrics[kind];
            const n = metric?.n ?? 0;
            const ready = metric?.mean != null;
            return (
              <div
                key={kind}
                className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-16 py-18"
                title={metric?.definition}
              >
                <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
                  {metric?.label || kind}
                </p>
                <p className="mt-8 text-[22px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
                  {!data
                    ? '—'
                    : ready
                      ? formatPct(metric.mean!)
                      : `Not enough data yet (${n}/${MIN_KIND_SAMPLES})`}
                </p>
                <p className="mt-6 text-[12px] text-[var(--studio-muted)]">
                  based on {n} generations · {trendLabel(metric?.trend ?? null)}
                </p>
                <p className="mt-8 text-[11px] leading-4 text-[var(--studio-faint)]">
                  {metric?.definition}
                </p>
              </div>
            );
          })}
        </div>
      </AdminCard>

      <AdminCard
        icon={<Wrench className="size-14" aria-hidden />}
        title="Tool refusals"
        description="How often each generation tool answered the model with a refusal instead of doing the work."
      >
        <p className="mb-12 text-[12px] text-[var(--studio-muted)]">
          Not part of the quality score, and deliberately one figure per tool rather than one
          blended rate: an add_dependency refusal is the write guard turning down a package the
          preview cannot serve, which is it working, while an edit_file refusal means the model
          could not find the text it meant to change. Recorded per generation from the tool results
          themselves, and shown once a tool has {MIN_KIND_SAMPLES} generations behind it.
        </p>
        {!data ? (
          <p className="text-[13px] text-[var(--studio-muted)]">
            {loading ? 'Loading…' : 'Not loaded.'}
          </p>
        ) : data.toolRefusals.length === 0 ? (
          <p className="text-[13px] text-[var(--studio-muted)]">
            No tool calls recorded in this range.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-4">
            {data.toolRefusals.map((row) => (
              <div
                key={row.tool}
                className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-16 py-18"
              >
                <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
                  {row.tool}
                </p>
                <p className="mt-8 text-[22px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
                  {row.rate != null
                    ? formatPct(row.rate)
                    : `Not enough data yet (${row.n}/${MIN_KIND_SAMPLES})`}
                </p>
                <p className="mt-6 text-[12px] text-[var(--studio-muted)]">
                  refused · based on {row.n} generations that called it
                </p>
              </div>
            ))}
          </div>
        )}
      </AdminCard>

      <AdminCard
        icon={<GitCommitHorizontal className="size-14" aria-hidden />}
        title="Prompt version history"
      >
        {!loading && data && data.versions.length === 0 ? (
          <p className="text-[13px] text-[var(--studio-muted)]">No prompt versions recorded yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-2">
            {(data?.versions || []).map((version) => (
              <div
                key={version.id}
                className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-16 py-18"
              >
                <p className="text-[14px] font-medium text-[var(--studio-fg)]">
                  {version.label}
                  {version.isActive ? ' · active' : ''}
                </p>
                <p className="mt-4 text-[12px] text-[var(--studio-muted)]">
                  Activated {formatAdminDate(version.createdAt)}
                </p>
                <p className="mt-8 text-[20px] font-medium text-[var(--studio-fg)]">
                  {version.overall != null
                    ? formatPct(version.overall)
                    : `Not enough data yet (${version.sampleCount}/30)`}
                </p>
                {version.overall != null && (
                  <ul className="mt-12 space-y-4 text-[12px] text-[var(--studio-muted)]">
                    {SHOWN_SIGNAL_KINDS.map((kind) => {
                      const row = version.metrics[kind];
                      return (
                        <li key={kind}>
                          {row?.label || kind}:{' '}
                          {row?.mean != null
                            ? formatPct(row.mean)
                            : `Not enough data yet (${row?.n ?? 0}/${MIN_KIND_SAMPLES})`}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </AdminCard>

      <AdminCard
        icon={<Coins className="size-14" aria-hidden />}
        title="Estimated cost by prompt version"
        description="What each version spent over this range, to be read next to what it scored above."
      >
        <p className="mb-12 text-[12px] text-[var(--studio-muted)]">
          Estimated, never billed: the cost is priced from token counts at the operator rate, the
          same number /admin/usage reports. Events counts every priced provider call in the range —
          builds, plans, images and helper calls — so the column totals the Generations tile above
          it. Input tokens are a floor rather than a total: a run that never attached a count
          contributes none, and only input tokens are kept per event.
        </p>
        {!data ? (
          <p className="text-[13px] text-[var(--studio-muted)]">
            {loading ? 'Loading…' : 'Not loaded.'}
          </p>
        ) : (
          <AdminTable
            isEmpty={data.costs.length === 0}
            empty="No generations in this range."
            head={
              <>
                <Th>Prompt version</Th>
                <Th align="right">Events</Th>
                <Th align="right">Estimated cost</Th>
                <Th align="right">Estimated per event</Th>
                <Th align="right">Input tokens</Th>
                <Th align="right">Tokens per event</Th>
              </>
            }
          >
            {data.costs.map((row) => (
              <Tr key={row.promptVersion ?? 'unversioned'}>
                <Td>{row.label}</Td>
                <Td align="right" muted>
                  {formatCount(row.events)}
                </Td>
                <Td align="right" muted>
                  {formatUsd(row.estimatedCostUsd)}
                </Td>
                <Td align="right" muted>
                  {row.costPerEventUsd != null ? formatUsd(row.costPerEventUsd) : '—'}
                </Td>
                <Td align="right" muted>
                  {formatCount(row.inputTokens)}
                </Td>
                <Td align="right" muted>
                  {row.tokensPerEvent != null ? formatCount(row.tokensPerEvent) : '—'}
                </Td>
              </Tr>
            ))}
          </AdminTable>
        )}
      </AdminCard>

      <AdminCard icon={<AlertCircle className="size-14" aria-hidden />} title="Recurring issues">
        {!data ? (
          <p className="text-[13px] text-[var(--studio-muted)]">
            {loading ? 'Loading…' : 'Not loaded.'}
          </p>
        ) : data.recurringIssues.length === 0 ? (
          <p className="text-[13px] text-[var(--studio-muted)]">
            No recurring code-audit issues yet.
          </p>
        ) : (
          <ul className="space-y-8">
            {data!.recurringIssues.map((issue) => (
              <li key={issue.category} className="text-[13px] text-[var(--studio-fg)]">
                <span className="font-medium">{issue.category}</span>
                {` · ${issue.count}`}
                <span className="text-[var(--studio-muted)]"> — {issue.sampleTitle}</span>
              </li>
            ))}
          </ul>
        )}
      </AdminCard>
    </AdminPage>
  );
}
