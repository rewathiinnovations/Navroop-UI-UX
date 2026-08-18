'use client';

import { FormEvent, useState } from 'react';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import PageTabs from '@/components/app/studio/PageTabs';
import type { PublicPlan } from '@/lib/plans/types';

const adminTabs = (active: string) => [
  { href: '/admin/team', label: 'Team', active: active === 'team' },
  { href: '/admin/usage', label: 'Usage', active: active === 'usage' },
  { href: '/admin/quality', label: 'Quality', active: active === 'quality' },
  { href: '/admin/jobs', label: 'Jobs', active: active === 'jobs' },
  { href: '/admin/backups', label: 'Backups', active: active === 'backups' },
  { href: '/admin/audit', label: 'Audit', active: active === 'audit' },
  { href: '/admin/integrations', label: 'Integrations', active: active === 'integrations' },
  { href: '/admin/deploy', label: 'Deploy', active: active === 'deploy' },
  { href: '/admin/servers', label: 'Servers', active: active === 'servers' },
  { href: '/admin/plans', label: 'Plans', active: active === 'plans' },
  { href: '/admin/workspace', label: 'Workspace', active: active === 'workspace' },
  { href: '/admin/sandbox-providers', label: 'Sandbox providers', active: active === 'sandbox-providers' },
];

const FIELDS = [
  ['monthlyCredits', 'Credits'],
  ['maxProjects', 'Projects'],
  ['maxLiveSites', 'Live'],
  ['maxPreviewSites', 'Preview'],
  ['maxMembers', 'Members'],
  ['maxConcurrentSandboxes', 'Sandboxes'],
  ['checkpointRetentionDays', 'Retention'],
  ['maxTokensPerJob', 'Tokens/job'],
  ['maxFilesPerJob', 'Files/job'],
  ['maxOutputBytesPerJob', 'Bytes/job'],
  ['monthlySandboxMinutes', 'Sandbox min'],
] as const;

export default function PlansAdmin({
  initialPlans,
  assignedPlanId,
}: {
  initialPlans: PublicPlan[];
  assignedPlanId: string | null;
}) {
  const [plans, setPlans] = useState(initialPlans);
  const [assigned, setAssigned] = useState(assignedPlanId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    setError('');
    try {
      const response = await fetch('/api/admin/plans', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...body }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || 'Could not update plan');
        return;
      }
      setPlans((current) =>
        current.map((plan) => {
          if (body.isDefault === true) {
            return plan.id === id ? payload.plan : { ...plan, isDefault: false };
          }
          return plan.id === id ? payload.plan : plan;
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy('create');
    setError('');
    try {
      const response = await fetch('/api/admin/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: form.get('key'),
          name: form.get('name'),
          monthlyCredits: Number(form.get('monthlyCredits') || 100),
          maxProjects: Number(form.get('maxProjects') || 5),
          maxLiveSites: Number(form.get('maxLiveSites') || 1),
          maxPreviewSites: Number(form.get('maxPreviewSites') || 3),
          maxMembers: Number(form.get('maxMembers') || 2),
          maxConcurrentSandboxes: Number(form.get('maxConcurrentSandboxes') || 1),
          checkpointRetentionDays: Number(form.get('checkpointRetentionDays') || 7),
          storageBytesLimit: String(form.get('storageBytesLimit') || 524288000),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || 'Could not create plan');
        return;
      }
      setPlans((current) => [...current, payload.plan]);
      event.currentTarget.reset();
    } finally {
      setBusy(null);
    }
  };

  const assign = async (planId: string) => {
    setBusy(`assign:${planId}`);
    setError('');
    try {
      const response = await fetch('/api/admin/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignPlanId: planId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || 'Could not assign plan');
        return;
      }
      setAssigned(planId);
    } finally {
      setBusy(null);
    }
  };

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[1100px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">Admin</h1>
        <PageTabs items={adminTabs('plans')} />
        {error && (
          <p className="mb-16 text-[13px] text-[var(--studio-danger)]" role="alert">
            {error}
          </p>
        )}

        <div className="overflow-x-auto rounded-12 border border-[var(--studio-line)]">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-[var(--studio-line)] text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              <tr>
                <th className="px-12 py-10 font-medium">Plan</th>
                {FIELDS.map(([_, label]) => (
                  <th key={label} className="px-8 py-10 font-medium">
                    {label}
                  </th>
                ))}
                <th className="px-8 py-10 font-medium">Storage</th>
                <th className="px-8 py-10 font-medium">Flags</th>
                <th className="px-8 py-10 font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.id} className="border-b border-[var(--studio-line)] last:border-0 align-top">
                  <td className="px-12 py-12">
                    <input
                      className="h-32 w-[120px] rounded-8 border border-[var(--studio-line)] bg-transparent px-8"
                      defaultValue={plan.name}
                      disabled={busy === plan.id}
                      onBlur={(event) => {
                        if (event.target.value !== plan.name) void patch(plan.id, { name: event.target.value });
                      }}
                    />
                    <div className="mt-4 text-[11px] text-[var(--studio-faint)]">{plan.key}</div>
                  </td>
                  {FIELDS.map(([field]) => (
                    <td key={field} className="px-8 py-12">
                      <input
                        type="number"
                        className="h-32 w-[72px] rounded-8 border border-[var(--studio-line)] bg-transparent px-6"
                        defaultValue={plan[field]}
                        disabled={busy === plan.id}
                        onBlur={(event) => {
                          const value = Number(event.target.value);
                          if (value !== plan[field]) void patch(plan.id, { [field]: value });
                        }}
                      />
                    </td>
                  ))}
                  <td className="px-8 py-12">
                    <input
                      className="h-32 w-[110px] rounded-8 border border-[var(--studio-line)] bg-transparent px-6"
                      defaultValue={plan.storageBytesLimit}
                      disabled={busy === plan.id}
                      onBlur={(event) => {
                        if (event.target.value !== plan.storageBytesLimit) {
                          void patch(plan.id, { storageBytesLimit: event.target.value });
                        }
                      }}
                    />
                  </td>
                  <td className="px-8 py-12">
                    <label className="flex items-center gap-6">
                      <input
                        type="checkbox"
                        checked={plan.isActive}
                        disabled={busy === plan.id || plan.isDefault}
                        onChange={(event) => void patch(plan.id, { isActive: event.target.checked })}
                      />
                      Active
                    </label>
                    <label className="mt-6 flex items-center gap-6">
                      <input
                        type="checkbox"
                        checked={plan.isDefault}
                        disabled={busy === plan.id}
                        onChange={(event) => {
                          if (event.target.checked) void patch(plan.id, { isDefault: true });
                        }}
                      />
                      Default
                    </label>
                    <label className="mt-6 flex items-center gap-6">
                      <input
                        type="checkbox"
                        checked={plan.allowCustomDomain}
                        disabled={busy === plan.id}
                        onChange={(event) => void patch(plan.id, { allowCustomDomain: event.target.checked })}
                      />
                      Domain
                    </label>
                    <label className="mt-6 flex items-center gap-6">
                      <input
                        type="checkbox"
                        checked={plan.allowGithubSync}
                        disabled={busy === plan.id}
                        onChange={(event) => void patch(plan.id, { allowGithubSync: event.target.checked })}
                      />
                      GitHub
                    </label>
                  </td>
                  <td className="px-8 py-12">
                    <StudioButton
                      type="button"
                      variant={assigned === plan.id ? 'primary' : 'ghost'}
                      disabled={busy === `assign:${plan.id}` || assigned === plan.id}
                      onClick={() => void assign(plan.id)}
                    >
                      {assigned === plan.id ? 'Assigned' : 'Assign workspace'}
                    </StudioButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form onSubmit={onCreate} className="mt-28 grid gap-12 sm:grid-cols-3">
          <h2 className="sm:col-span-3 text-[18px] font-medium text-[var(--studio-fg)]">Create plan</h2>
          <input name="key" required placeholder="key (pro-plus)" className="h-40 rounded-10 border border-[var(--studio-line)] px-12" />
          <input name="name" required placeholder="Name" className="h-40 rounded-10 border border-[var(--studio-line)] px-12" />
          <input name="monthlyCredits" type="number" defaultValue={200} className="h-40 rounded-10 border border-[var(--studio-line)] px-12" />
          <input name="maxProjects" type="number" defaultValue={10} className="h-40 rounded-10 border border-[var(--studio-line)] px-12" />
          <input name="maxLiveSites" type="number" defaultValue={2} className="h-40 rounded-10 border border-[var(--studio-line)] px-12" />
          <input name="maxPreviewSites" type="number" defaultValue={5} className="h-40 rounded-10 border border-[var(--studio-line)] px-12" />
          <input name="maxMembers" type="number" defaultValue={5} className="h-40 rounded-10 border border-[var(--studio-line)] px-12" />
          <input name="maxConcurrentSandboxes" type="number" defaultValue={2} className="h-40 rounded-10 border border-[var(--studio-line)] px-12" />
          <input name="checkpointRetentionDays" type="number" defaultValue={14} className="h-40 rounded-10 border border-[var(--studio-line)] px-12" />
          <input name="storageBytesLimit" defaultValue="1073741824" className="h-40 rounded-10 border border-[var(--studio-line)] px-12" />
          <div className="sm:col-span-3">
            <StudioButton type="submit" variant="primary" disabled={busy === 'create'}>
              {busy === 'create' ? 'Creating…' : 'Create plan'}
            </StudioButton>
          </div>
        </form>
      </main>
    </StudioShell>
  );
}

export { adminTabs };
