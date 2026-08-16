'use client';

import { Fragment, FormEvent, useEffect, useMemo, useState } from 'react';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import PageTabs from '@/components/app/studio/PageTabs';

type Summary = {
  totalProjects: number;
  totalGenerations: number;
  totalEstimatedCost: number;
};

type MemberRow = {
  userId: string;
  name: string;
  email: string;
  projectCount: number;
  generationCount: number;
  estimatedCost: number;
  projects: Array<{ id: string; name: string }>;
};

type ProjectEvent = {
  kind: string;
  cost: number;
  createdAt: string;
  userName: string;
};

function currentMonthInputs(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const from = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const to = `${year}-${String(month + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { from, to };
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function UsageDashboard() {
  const defaults = useMemo(() => currentMonthInputs(), []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [applied, setApplied] = useState(defaults);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [eventsByProject, setEventsByProject] = useState<Record<string, ProjectEvent[]>>({});
  const [loadingProjects, setLoadingProjects] = useState(false);

  const query = `from=${encodeURIComponent(applied.from)}&to=${encodeURIComponent(applied.to)}`;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const [summaryRes, membersRes] = await Promise.all([
          fetch(`/api/admin/usage/summary?${query}`),
          fetch(`/api/admin/usage/by-member?${query}`),
        ]);
        if (summaryRes.status === 403 || membersRes.status === 403) {
          window.location.replace('/dashboard');
          return;
        }
        const summaryData = await summaryRes.json();
        const membersData = await membersRes.json();
        if (!summaryRes.ok) {
          if (!cancelled) setError(summaryData.error || 'Could not load usage');
          return;
        }
        if (!membersRes.ok) {
          if (!cancelled) setError(membersData.error || 'Could not load usage');
          return;
        }
        if (!cancelled) {
          setSummary(summaryData);
          setMembers(membersData.members || []);
        }
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
    setExpanded(null);
    setEventsByProject({});
    setApplied({ from, to });
  };

  const toggleMember = async (member: MemberRow) => {
    if (expanded === member.userId) {
      setExpanded(null);
      return;
    }
    setExpanded(member.userId);
    const missing = member.projects.filter((project) => !eventsByProject[project.id]);
    if (missing.length === 0) return;
    setLoadingProjects(true);
    try {
      const results = await Promise.all(
        missing.map(async (project) => {
          const response = await fetch(`/api/admin/usage/project/${project.id}`);
          const data = await response.json();
          return { id: project.id, events: (data.events || []) as ProjectEvent[] };
        }),
      );
      setEventsByProject((current) => {
        const next = { ...current };
        for (const row of results) next[row.id] = row.events;
        return next;
      });
    } finally {
      setLoadingProjects(false);
    }
  };

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[960px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">Admin</h1>
        <PageTabs
          items={[
            { href: '/admin/team', label: 'Team' },
            { href: '/admin/usage', label: 'Usage', active: true },
          ]}
        />

        <form onSubmit={applyRange} className="mb-24 flex flex-col gap-12 sm:flex-row sm:items-end">
          <StudioField
            id="usage-from"
            label="From"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            required
          />
          <StudioField
            id="usage-to"
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
            { label: 'Total Projects', value: summary ? String(summary.totalProjects) : '—' },
            { label: 'Total Generations', value: summary ? String(summary.totalGenerations) : '—' },
            {
              label: 'Estimated Spend',
              value: summary ? formatMoney(summary.totalEstimatedCost) : '—',
              hint: 'Estimate — not live billing',
            },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-18"
            >
              <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">{card.label}</p>
              <p className="mt-8 text-[28px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">{card.value}</p>
              {'hint' in card && card.hint && (
                <p className="mt-4 text-[12px] text-[var(--studio-muted)]">{card.hint}</p>
              )}
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)]">
          <table className="w-full text-left text-[14px]">
            <thead className="border-b border-[var(--studio-line)] text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              <tr>
                <th className="px-16 py-12 font-medium">Member</th>
                <th className="px-16 py-12 font-medium">Projects</th>
                <th className="px-16 py-12 font-medium">Generations</th>
                <th className="px-16 py-12 font-medium">Estimated spend</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <Fragment key={member.userId}>
                  <tr
                    className="cursor-pointer border-b border-[var(--studio-line)] last:border-0 hover:bg-[var(--studio-surface-hover)]"
                    onClick={() => void toggleMember(member)}
                  >
                    <td className="px-16 py-14">
                      <div className="font-medium text-[var(--studio-fg)]">{member.name}</div>
                      <div className="text-[12px] text-[var(--studio-muted)]">{member.email}</div>
                    </td>
                    <td className="px-16 py-14 text-[var(--studio-muted)]">{member.projectCount}</td>
                    <td className="px-16 py-14 text-[var(--studio-muted)]">{member.generationCount}</td>
                    <td className="px-16 py-14 text-[var(--studio-muted)]">{formatMoney(member.estimatedCost)}</td>
                  </tr>
                  {expanded === member.userId && (
                    <tr className="border-b border-[var(--studio-line)] last:border-0">
                      <td colSpan={4} className="px-16 py-14">
                        {member.projects.length === 0 ? (
                          <p className="text-[13px] text-[var(--studio-muted)]">No projects in this range.</p>
                        ) : loadingProjects && member.projects.some((project) => !eventsByProject[project.id]) ? (
                          <p className="text-[13px] text-[var(--studio-muted)]">Loading projects…</p>
                        ) : (
                          <div className="space-y-16">
                            {member.projects.map((project) => (
                              <div key={project.id}>
                                <p className="mb-8 text-[13px] font-medium text-[var(--studio-fg)]">{project.name}</p>
                                <ul className="space-y-4 text-[12px] text-[var(--studio-muted)]">
                                  {(eventsByProject[project.id] || []).map((event, index) => (
                                    <li key={`${project.id}-${index}`}>
                                      {event.kind} · {formatMoney(event.cost)} · {formatWhen(event.createdAt)}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!loading && members.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-16 py-18 text-[13px] text-[var(--studio-muted)]">
                    No usage in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </StudioShell>
  );
}
