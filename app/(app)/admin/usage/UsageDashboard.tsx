'use client';

import {
  Brain,
  Bug,
  ChevronDown,
  DollarSign,
  FolderOpen,
  ShieldAlert,
  Sparkles,
  Users2,
} from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import { AdminTable, Td, Th, Tr } from '@/components/admin/AdminTable';
import StatTile from '@/components/admin/StatTile';
import StatusBanner from '@/components/admin/StatusBanner';
import { handleAdminForbidden } from '@/lib/admin/forbidden';
import { fetchJson, notify, toMessage } from '@/lib/notify';
import { SkeletonTable } from '@/components/admin/AdminSkeleton';
import { Fragment, FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import { listSkills, type PublicSkill } from '@/lib/skills/actions';
import { getMemoryExtractionSetting, updateMemoryExtractionSetting } from '@/lib/memory/actions';
import { formatAdminDateTime } from '../format-admin-date';

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

type SsrfRejects = {
  total: number;
  byUser: Record<string, number>;
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
  return formatAdminDateTime(value);
}

export default function UsageDashboard() {
  const router = useRouter();
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
  const [ssrfRejects, setSsrfRejects] = useState<SsrfRejects>({ total: 0, byUser: {} });
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
          handleAdminForbidden(router);
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
            if (qualityData.ssrfPrivateRejects) {
              setSsrfRejects({
                total: Number(qualityData.ssrfPrivateRejects.total) || 0,
                byUser: qualityData.ssrfPrivateRejects.byUser || {},
              });
            }
          }
          const skillsResult = await listSkills();
          if (skillsResult.ok) setSkills(skillsResult.data);
          const extraction = await getMemoryExtractionSetting();
          if (extraction.ok) setMemoryExtractionEnabled(extraction.data.enabled);
        }
      } catch (cause) {
        if (!cancelled) setError(toMessage(cause, 'Could not load usage'));
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
          const data = await fetchJson<{ events?: ProjectEvent[] }>(
            `/api/admin/usage/project/${project.id}`,
          );
          return { id: project.id, events: data.events || [] };
        }),
      );
      setEventsByProject((current) => {
        const next = { ...current };
        for (const row of results) next[row.id] = row.events;
        return next;
      });
    } catch (cause) {
      // Without this the rejected Promise.all surfaced only as an unhandled
      // rejection and the row just stayed blank.
      notify.error(cause, {
        fallback: 'Could not load usage for those projects',
        key: `usage-projects-${member.userId}`,
      });
    } finally {
      setLoadingProjects(false);
    }
  };

  return (
    <AdminPage
      icon="usage"
      title="Usage"
      description="What was generated, by whom, and what it cost."
      width="wide"
      actions={
        <form onSubmit={applyRange} className="flex flex-wrap items-end gap-8">
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
      }
    >
      {error && <StatusBanner tone="error">{error}</StatusBanner>}

      <div className="grid grid-cols-1 gap-12 sm:grid-cols-3">
        <StatTile
          icon={<FolderOpen className="size-16" aria-hidden />}
          value={summary ? summary.totalProjects : '—'}
          label="Total projects"
        />
        <StatTile
          icon={<Users2 className="size-16" aria-hidden />}
          value={summary ? summary.totalGenerations : '—'}
          label="Total generations"
        />
        <StatTile
          icon={<DollarSign className="size-16" aria-hidden />}
          value={summary ? formatMoney(summary.totalEstimatedCost) : '—'}
          label="Estimated spend"
          hint="Estimate — not live billing"
        />
      </div>

      {ssrfRejects.total > 0 && (
        <AdminCard
          icon={<ShieldAlert className="size-14" aria-hidden />}
          title="Private-range import blocks"
          description={`Repeated SSRF-style import attempts (private / localhost / link-local). ${ssrfRejects.total} total.`}
        >
          <ul className="space-y-8">
            {Object.entries(ssrfRejects.byUser)
              .sort((a, b) => b[1] - a[1])
              .map(([userId, count]) => {
                const member = members.find((row) => row.userId === userId);
                return (
                  <li
                    key={userId}
                    className="flex items-baseline justify-between gap-12 text-[13px]"
                  >
                    <span className="text-[var(--studio-fg)]">
                      {member?.name || member?.email || userId}
                    </span>
                    <span className="text-[var(--studio-faint)]">{count}</span>
                  </li>
                );
              })}
          </ul>
        </AdminCard>
      )}

      {qualityIssues.length > 0 && (
        <AdminCard
          icon={<Bug className="size-14" aria-hidden />}
          title="Recurring code-quality issues"
          description="Frequent finding categories across recent CodeAudits — use these to tighten base-rules."
        >
          <ul className="space-y-8">
            {qualityIssues.map((issue) => (
              <li
                key={issue.category}
                className="flex items-baseline justify-between gap-12 text-[13px]"
              >
                <span className="text-[var(--studio-fg)]">
                  {issue.category}
                  <span className="ml-8 text-[var(--studio-muted)]">{issue.sampleTitle}</span>
                </span>
                <span className="text-[var(--studio-faint)]">{issue.count}</span>
              </li>
            ))}
          </ul>
        </AdminCard>
      )}

      <AdminCard icon={<Users2 className="size-14" aria-hidden />} title="By member">
        {loading && members.length === 0 ? (
          <SkeletonTable rows={4} cols={5} />
        ) : (
          <AdminTable
            isEmpty={!loading && !error && members.length === 0}
            empty="No usage in this range."
            head={
              <>
                <Th>Member</Th>
                <Th>Projects</Th>
                <Th>Generations</Th>
                <Th>Estimated spend</Th>
                <Th align="right"> </Th>
              </>
            }
          >
            {members.map((member) => {
              const isOpen = expanded === member.userId;
              const detailId = `member-usage-${member.userId}`;
              return (
                <Fragment key={member.userId}>
                  <Tr>
                    <Td>
                      {/* The drill-down is the reason this table exists, so the
                          toggle is a real button — the row itself carries no
                          click semantics. */}
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={detailId}
                        onClick={() => void toggleMember(member)}
                        className="-mx-4 rounded-8 px-4 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
                      >
                        <span className="block font-medium text-[var(--studio-fg)]">
                          {member.name}
                        </span>
                        <span className="block text-[12px] text-[var(--studio-muted)]">
                          {member.email}
                        </span>
                      </button>
                    </Td>
                    <Td muted>{member.projectCount}</Td>
                    <Td muted>{member.generationCount}</Td>
                    <Td muted>{formatMoney(member.estimatedCost)}</Td>
                    <Td align="right">
                      <ChevronDown
                        className={`ml-auto size-14 text-[var(--studio-faint)] transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                        aria-hidden
                      />
                    </Td>
                  </Tr>
                  {isOpen && (
                    <Tr id={detailId}>
                      <Td colSpan={5}>
                        {member.projects.length === 0 ? (
                          <p className="text-[13px] text-[var(--studio-muted)]">
                            No projects in this range.
                          </p>
                        ) : loadingProjects &&
                          member.projects.some((project) => !eventsByProject[project.id]) ? (
                          <p className="text-[13px] text-[var(--studio-muted)]">
                            Loading projects…
                          </p>
                        ) : (
                          <div className="space-y-16">
                            {member.projects.map((project) => (
                              <div key={project.id}>
                                <p className="mb-8 text-[13px] font-medium text-[var(--studio-fg)]">
                                  {project.name}
                                </p>
                                <ul className="space-y-4 text-[12px] text-[var(--studio-muted)]">
                                  {(eventsByProject[project.id] || []).map((event, index) => (
                                    <li key={`${project.id}-${index}`}>
                                      {event.kind} · {formatMoney(event.cost)} ·{' '}
                                      {formatWhen(event.createdAt)}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        )}
                      </Td>
                    </Tr>
                  )}
                </Fragment>
              );
            })}
          </AdminTable>
        )}
      </AdminCard>

      <AdminCard
        icon={<Sparkles className="size-14" aria-hidden />}
        title="Skills"
        description="Sorted by usage. Zero-usage skills never matched or are unused."
      >
        {loading && skills.length === 0 ? (
          <SkeletonTable rows={3} cols={4} />
        ) : (
          <AdminTable
            isEmpty={!loading && !error && skills.length === 0}
            empty="No workspace skills yet."
            head={
              <>
                <Th>Skill</Th>
                <Th>Enabled</Th>
                <Th align="right">Usage</Th>
              </>
            }
          >
            {skills.map((skill) => (
              <Tr key={skill.id}>
                <Td>
                  <div className="font-medium text-[var(--studio-fg)]">{skill.name}</div>
                  <div className="text-[12px] text-[var(--studio-muted)]">{skill.description}</div>
                </Td>
                <Td muted>{skill.enabled ? 'On' : 'Off'}</Td>
                <Td align="right" muted>
                  {skill.usageCount}
                </Td>
              </Tr>
            ))}
          </AdminTable>
        )}
      </AdminCard>

      <AdminCard icon={<Brain className="size-14" aria-hidden />} title="Brain memory">
        <p className="text-[13px] text-[var(--studio-muted)]">
          When off, auto-extraction after a generation does not run. Manual memory still injects.
        </p>
        <label className="mt-12 inline-flex items-center gap-8 text-[13px] text-[var(--studio-fg)]">
          <input
            type="checkbox"
            className="size-16 rounded-4 accent-[var(--studio-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
            checked={memoryExtractionEnabled}
            disabled={savingExtraction}
            onChange={async (event) => {
              // No `.catch` used to mean a rejected server action left
              // `savingExtraction` true forever, so `disabled` locked the checkbox
              // for the life of the page — and a clean `ok: false` snapped the box
              // back with no message at all. Both now say what happened.
              const next = event.target.checked;
              setSavingExtraction(true);
              try {
                const result = await updateMemoryExtractionSetting(next);
                if (!result.ok) {
                  notify.error(result.error, { key: 'memory-extraction' });
                  return;
                }
                setMemoryExtractionEnabled(result.data.enabled);
                notify.success(
                  result.data.enabled
                    ? 'Memory is extracted automatically after a generation.'
                    : 'Automatic memory extraction is off.',
                  { key: 'memory-extraction' },
                );
              } catch (cause) {
                notify.error(cause, {
                  fallback: 'Could not save the memory setting',
                  key: 'memory-extraction',
                });
              } finally {
                setSavingExtraction(false);
              }
            }}
          />
          Automatically extract memory after generation
        </label>
      </AdminCard>
    </AdminPage>
  );
}
