'use client';

import AdminPage from '@/components/admin/AdminPage';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import {
  MIN_KIND_SAMPLES,
  QUALITY_SIGNAL_KINDS,
  type QualitySignalKind,
} from '@/lib/signals/score';
import { formatAdminDate } from '../format-admin-date';

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
      title="Quality"
      description="How well generation is performing over time, and the problems that keep recurring."
      width="wide"
    >
      <form onSubmit={applyRange} className="mb-24 flex flex-col gap-12 sm:flex-row sm:items-end">
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

      {error && (
        <p className="mb-16 text-[13px] text-[var(--studio-danger)]" role="alert">
          {error}
        </p>
      )}

      <div className="mb-24 grid grid-cols-1 gap-12 sm:grid-cols-3">
        {[
          { label: 'Generations', value: data ? String(data.summary.totalGenerations) : '—' },
          { label: 'Active days', value: data ? String(data.summary.activeDays) : '—' },
          { label: 'Prompt version', value: data?.summary.promptVersionLabel || '—' },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-18"
          >
            <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              {card.label}
            </p>
            <p className="mt-8 text-[28px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
              {card.value}
            </p>
          </div>
        ))}
      </div>

      {data?.overall != null && (
        <p className="mb-16 text-[13px] text-[var(--studio-muted)]">
          Overall quality score {formatPct(data.overall)} — weighted composite, shown only with 30+
          samples.
        </p>
      )}

      <div className="mb-32 grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-4">
        {QUALITY_SIGNAL_KINDS.map((kind) => {
          const metric = data?.metrics[kind];
          const n = metric?.n ?? 0;
          const ready = metric?.mean != null;
          return (
            <div
              key={kind}
              className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-18"
              title={metric?.definition}
            >
              <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
                {metric?.label || kind}
              </p>
              <p className="mt-8 text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
                {ready ? formatPct(metric.mean!) : `Not enough data yet (${n}/${MIN_KIND_SAMPLES})`}
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

      <section className="mb-32">
        <h2 className="mb-12 text-[18px] font-medium text-[var(--studio-fg)]">
          Prompt version history
        </h2>
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-2">
          {(data?.versions || []).map((version) => (
            <div
              key={version.id}
              className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-18"
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
                  {QUALITY_SIGNAL_KINDS.map((kind) => {
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
          {!loading && (data?.versions || []).length === 0 && (
            <p className="text-[13px] text-[var(--studio-muted)]">
              No prompt versions recorded yet.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-12 text-[18px] font-medium text-[var(--studio-fg)]">Recurring issues</h2>
        {(data?.recurringIssues || []).length === 0 ? (
          <p className="text-[13px] text-[var(--studio-muted)]">
            No recurring code-audit issues yet.
          </p>
        ) : (
          <ul className="space-y-8 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-14">
            {data!.recurringIssues.map((issue) => (
              <li key={issue.category} className="text-[13px] text-[var(--studio-fg)]">
                <span className="font-medium">{issue.category}</span>
                {` · ${issue.count}`}
                <span className="text-[var(--studio-muted)]"> — {issue.sampleTitle}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AdminPage>
  );
}
