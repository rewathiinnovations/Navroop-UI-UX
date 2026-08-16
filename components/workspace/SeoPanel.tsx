'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Loader2, Search } from 'lucide-react';
import { cn } from '@/utils/cn';
import { relativeTime } from '@/lib/projects/prompt';
import { sortFindings } from '@/lib/seo/findings';
import type { SeoFinding, SeoSeverity } from '@/lib/seo/types';
import type { SendMessageOptions } from './types';
import { useSeoAudit } from './useSeoAudit';

const SEVERITY_LABEL: Record<SeoSeverity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  pass: 'Pass',
};

function SeverityBadge({ status, fixed }: { status: SeoSeverity; fixed?: boolean }) {
  if (fixed && status !== 'pass') {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--studio-accent-soft)] px-8 py-2 text-[11px] font-medium text-[var(--studio-accent)]">
        Fixed
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-8 py-2 text-[11px] font-medium',
        status === 'high' && 'bg-rose-100 text-rose-800',
        status === 'medium' && 'bg-amber-100 text-amber-800',
        status === 'low' && 'bg-sky-100 text-sky-800',
        status === 'pass' && 'bg-emerald-100 text-emerald-800',
      )}
    >
      {SEVERITY_LABEL[status]}
    </span>
  );
}

function FindingRow({
  item,
  busy,
  onFix,
  onIgnore,
}: {
  item: SeoFinding;
  busy: boolean;
  onFix: (id: string) => void;
  onIgnore: (id: string) => void;
}) {
  return (
    <li className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-12">
      <div className="flex flex-wrap items-start justify-between gap-8">
        <div className="min-w-0 flex-1">
          <div className="mb-6 flex flex-wrap items-center gap-6">
            <SeverityBadge status={item.status} fixed={item.fixed} />
            <p className="text-[13px] font-medium text-[var(--studio-fg)]">{item.title}</p>
          </div>
          <p className="text-[12px] leading-5 text-[var(--studio-muted)]">{item.detail}</p>
        </div>
        {item.status !== 'pass' && (
          <div className="flex shrink-0 items-center gap-6">
            {item.fixable !== false && !item.ignored && (
              <button
                type="button"
                disabled={busy || item.fixed}
                onClick={() => onFix(item.id)}
                className="inline-flex min-h-[32px] items-center rounded-full border border-[var(--studio-line-strong)] px-10 text-[12px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Try to fix
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => onIgnore(item.id)}
              className="inline-flex min-h-[32px] items-center rounded-full px-10 text-[12px] font-medium text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {item.ignored ? 'Restore' : 'Ignore'}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function CollapsedGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-16">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between rounded-10 px-4 py-6 text-left text-[12px] font-medium text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
      >
        <span>
          {title} ({count})
        </span>
        <ChevronDown className={cn('size-14 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <ul className="mt-8 space-y-8">{children}</ul>}
    </section>
  );
}

export default function SeoPanel({
  projectId,
  projectUpdatedAt,
  onSend,
  sending,
}: {
  projectId: string;
  projectUpdatedAt: string | null;
  onSend: (text: string, options: SendMessageOptions) => void;
  sending?: boolean;
}) {
  const { audit, scanning, error, scan, fixOne, fixAll, toggleIgnore } = useSeoAudit(projectId);
  const [busyId, setBusyId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const sorted = sortFindings(audit?.findings ?? []);
    return {
      failures: sorted.filter((row) => !row.ignored && row.status !== 'pass'),
      passing: sorted.filter((row) => !row.ignored && row.status === 'pass'),
      ignored: sorted.filter((row) => row.ignored),
    };
  }, [audit]);

  const stale =
    Boolean(audit && projectUpdatedAt && new Date(projectUpdatedAt).getTime() > new Date(audit.scannedAt).getTime());

  const handleFix = async (id: string) => {
    setBusyId(id);
    const result = await fixOne(id);
    setBusyId(null);
    if (result.ok) onSend(result.promptContext, { mode: 'build' });
  };

  const handleFixAll = async () => {
    setBusyId('all');
    const result = await fixAll();
    setBusyId(null);
    if (result.ok) onSend(result.promptContext, { mode: 'build' });
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--studio-bg)]">
      <div className="flex flex-wrap items-center justify-between gap-12 border-b border-[var(--studio-line)] px-16 py-12">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--studio-fg)]">SEO</h2>
          <p className="text-[12px] text-[var(--studio-faint)]">
            {scanning
              ? 'Scanning preview and files…'
              : audit
                ? `Last scan ${relativeTime(audit.scannedAt)}${stale ? ' — site changed since last scan' : ''}`
                : 'On-demand audit of the generated site'}
          </p>
        </div>
        <div className="flex items-center gap-8">
          {grouped.failures.length > 0 && (
            <button
              type="button"
              disabled={scanning || Boolean(busyId) || sending}
              onClick={() => void handleFixAll()}
              className="inline-flex h-36 items-center rounded-full border border-[var(--studio-line-strong)] px-14 text-[13px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Try to fix all
            </button>
          )}
          <button
            type="button"
            disabled={scanning}
            onClick={() => void scan()}
            className="inline-flex h-36 items-center gap-6 rounded-full bg-[var(--studio-fg)] px-14 text-[13px] font-medium text-[var(--studio-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {scanning ? <Loader2 className="size-14 animate-spin" /> : <Search className="size-14" />}
            {audit ? 'Scan again' : 'Scan'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-16 py-16">
        {error && (
          <p className="mb-12 text-[13px] text-[var(--studio-danger)]" role="alert">
            {error}
          </p>
        )}
        {!audit && !scanning && (
          <div className="flex flex-col items-center justify-center px-24 py-48 text-center">
            <p className="max-w-[320px] text-[14px] leading-6 text-[var(--studio-muted)]">
              Scan this Navroop preview for titles, social tags, structured data, robots, and sitemap.
            </p>
          </div>
        )}
        {audit && (
          <>
            <ul className="space-y-8">
              {grouped.failures.map((item) => (
                <FindingRow
                  key={item.id}
                  item={item}
                  busy={scanning || Boolean(busyId) || Boolean(sending)}
                  onFix={(id) => void handleFix(id)}
                  onIgnore={(id) => void toggleIgnore(id)}
                />
              ))}
            </ul>
            {grouped.failures.length === 0 && (
              <p className="text-[13px] text-[var(--studio-muted)]">No open SEO issues.</p>
            )}
            {grouped.passing.length > 0 && (
              <CollapsedGroup title="Passing" count={grouped.passing.length}>
                {grouped.passing.map((item) => (
                  <FindingRow
                    key={item.id}
                    item={item}
                    busy
                    onFix={() => undefined}
                    onIgnore={() => undefined}
                  />
                ))}
              </CollapsedGroup>
            )}
            {grouped.ignored.length > 0 && (
              <CollapsedGroup title="Ignored" count={grouped.ignored.length}>
                {grouped.ignored.map((item) => (
                  <FindingRow
                    key={item.id}
                    item={item}
                    busy={scanning || Boolean(busyId)}
                    onFix={() => undefined}
                    onIgnore={(id) => void toggleIgnore(id)}
                  />
                ))}
              </CollapsedGroup>
            )}
          </>
        )}
      </div>
    </div>
  );
}
