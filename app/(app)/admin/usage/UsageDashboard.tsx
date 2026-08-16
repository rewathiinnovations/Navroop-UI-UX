'use client';

import { Fragment, FormEvent, useEffect, useMemo, useState } from 'react';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import PageTabs from '@/components/app/studio/PageTabs';
import { listSkills, type PublicSkill } from '@/lib/skills/actions';
import { getMemoryExtractionSetting, updateMemoryExtractionSetting } from '@/lib/memory/actions';

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

type RecurringIssue = {
  category: string;
  count: number;
  sampleTitle: string;
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
  const [qualityIssues, setQualityIssues] = useState<RecurringIssue[]>([]);
  const [skills, setSkills] = useState<PublicSkill[]>([]);
  const [memoryExtractionEnabled, setMemoryExtractionEnabled] = useState(true);
  const [savingExtraction, setSavingExtraction] = useState(false);

  const query = `from=${encodeURIComponent(applied.from)}&to=${encodeURIComponent(applied.to)}`;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const [summaryRes, membersRes, qualityRes] = await Promise.all([
          fetch(`/api/admin/usage/summary?${query}`),
          fetch(`/api/admin/usage/by-member?${query}`),
          fetch('/api/admin/usage/quality'),
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
          if (qualityRes.ok) {
            const qualityData = await qualityRes.json();
            setQualityIssues(qualityData.issues || []);
          }
          const skillsResult = await listSkills();
          if (skillsResult.ok) setSkills(skillsResult.data);
          const extraction = await getMemoryExtractionSetting();
          if (extraction.ok) setMemoryExtractionEnabled(extraction.data.enabled);
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
            { href: '/admin/quality', label: 'Quality' },
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

        {qualityIssues.length > 0 && (
          <section className="mb-24 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-16">
            <h2 className="text-[16px] font-medium text-[var(--studio-fg)]">Recurring code-quality issues</h2>
            <p className="mt-4 text-[12px] text-[var(--studio-muted)]">
              Frequent finding categories across recent CodeAudits — use these to tighten base-rules.
            </p>
            <ul className="mt-12 space-y-8">
              {qualityIssues.map((issue) => (
                <li key={issue.category} className="flex items-baseline justify-between gap-12 text-[13px]">
                  <span className="text-[var(--studio-fg)]">
                    {issue.category}
                    <span className="ml-8 text-[var(--studio-muted)]">{issue.sampleTitle}</span>
                  </span>
                  <span className="text-[var(--studio-faint)]">{issue.count}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

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

        <section className="mt-24 overflow-hidden rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)]">
          <div className="border-b border-[var(--studio-line)] px-16 py-14">
            <h2 className="text-[16px] font-medium text-[var(--studio-fg)]">Skills</h2>
            <p className="mt-4 text-[12px] text-[var(--studio-muted)]">
              Sorted by usage. Zero-usage skills never matched or are unused.
            </p>
          </div>
          <table className="w-full text-left text-[14px]">
            <thead className="border-b border-[var(--studio-line)] text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              <tr>
                <th className="px-16 py-12 font-medium">Skill</th>
                <th className="px-16 py-12 font-medium">Enabled</th>
                <th className="px-16 py-12 font-medium">Usage</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr key={skill.id} className="border-b border-[var(--studio-line)] last:border-0">
                  <td className="px-16 py-14">
                    <div className="font-medium text-[var(--studio-fg)]">{skill.name}</div>
                    <div className="text-[12px] text-[var(--studio-muted)]">{skill.description}</div>
                  </td>
                  <td className="px-16 py-14 text-[var(--studio-muted)]">{skill.enabled ? 'On' : 'Off'}</td>
                  <td className="px-16 py-14 text-[var(--studio-muted)]">{skill.usageCount}</td>
                </tr>
              ))}
              {!loading && skills.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-16 py-18 text-[13px] text-[var(--studio-muted)]">
                    No workspace skills yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="mt-24 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-14">
          <h2 className="text-[16px] font-medium text-[var(--studio-fg)]">Brain memory</h2>
          <p className="mt-4 text-[12px] text-[var(--studio-muted)]">
            When off, auto-extraction after a generation does not run. Manual memory still injects.
          </p>
          <label className="mt-12 inline-flex items-center gap-8 text-[13px] text-[var(--studio-fg)]">
            <input
              type="checkbox"
              checked={memoryExtractionEnabled}
              disabled={savingExtraction}
              onChange={(event) => {
                const next = event.target.checked;
                setSavingExtraction(true);
                void updateMemoryExtractionSetting(next).then((result) => {
                  setSavingExtraction(false);
                  if (result.ok) setMemoryExtractionEnabled(result.data.enabled);
                });
              }}
            />
            memoryExtractionEnabled
          </label>
        </section>
      </main>
    </StudioShell>
  );
}
