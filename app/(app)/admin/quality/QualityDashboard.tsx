'use client';

import { AlertCircle, FolderOpen, Gauge, GitCommitHorizontal, Sparkles } from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import StatTile from '@/components/admin/StatTile';
import StatusBanner from '@/components/admin/StatusBanner';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import {
  MIN_KIND_SAMPLES,
  QUALITY_SIGNAL_KINDS,
  type QualitySignalKind,
} from '@/lib/signals/score';
import { formatAdminDate } from '../format-admin-date';
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

type Dashboard = {
  summary: {
    totalGenerations: number;
    activeDays: number;
    promptVersionLabel: string;
  };
  metrics: Record<QualitySignalKind, KindMetric>;
  overall: number | null;
  versions: VersionRow[];
  recurringIssues: RecurringIssue[];
};

function last30DayInputs(now = new Date()) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  const fmt = (date: Date) => date.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

/**
 * F-705: type_safety, a11y_score and build_success are fabricated — the code
 * audit runs its static checks with no sandbox, so the collectors record a
 * perfect 1.0 for projects that were never analysed. Hidden here until the
 * Wave 4 pipeline fix (see audit/FIXES.md F-705). The collectors keep writing
 * rows, so history survives the outage.
 */
const BROKEN_SIGNAL_KINDS: Partial<Record<QualitySignalKind, true>> = {
  type_safety: true,
  a11y_score: true,
  build_success: true,
};
const SHOWN_SIGNAL_KINDS = QUALITY_SIGNAL_KINDS.filter((kind) => !BROKEN_SIGNAL_KINDS[kind]);

function formatPct(value: number) {
  return `${Math.round(value * 1000) / 10}%`;
}

function trendLabel(trend: number | null) {
  if (trend == null) return '—';
  const pct = Math.round(trend * 1000) / 10;
  if (pct > 0) return `↑ ${pct} pts`;
  if (pct < 0) return `↓ ${Math.abs(pct)} pts`;
  return '→ 0';
}

export default function QualityDashboard() {
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
          window.location.replace('/dashboard');
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
  }, [query]);

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
          Type safety, accessibility and build-success scores are hidden: their measurement is
          broken and records perfect scores. See audit/FIXES.md F-705.
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
