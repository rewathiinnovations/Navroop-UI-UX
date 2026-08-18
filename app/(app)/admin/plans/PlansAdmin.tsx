'use client';

import { Layers, Plus } from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import { AdminTable, Td, Th, Tr } from '@/components/admin/AdminTable';
import { notify } from '@/lib/notify';
import { FormEvent, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import type { PublicPlan } from '@/lib/plans/types';

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

const INPUT_CLASS =
  'h-32 w-full rounded-8 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-8 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]';

export default function PlansAdmin({
  initialPlans,
  assignedPlanId,
}: {
  initialPlans: PublicPlan[];
  assignedPlanId: string | null;
}) {
  const [plans, setPlans] = useState(initialPlans);
  const [assigned, setAssigned] = useState(assignedPlanId);
  const [busy, setBusy] = useState<string | null>(null);

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    try {
      const response = await fetch('/api/admin/plans', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...body }),
      });
      const payload = await response.json();
      if (!response.ok) {
        notify.error(payload.error || 'Could not update plan', { key: `plan-${id}` });
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
      notify.success(
        body.isDefault === true ? 'Default plan updated.' : 'Plan updated.',
        { key: `plan-${id}` },
      );
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not update plan', key: `plan-${id}` });
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy('create');
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
        notify.error(payload.error || 'Could not create plan', { key: 'plan-create' });
        return;
      }
      setPlans((current) => [...current, payload.plan]);
      formElement.reset();
      notify.success(`Plan “${payload.plan.name}” created.`, { key: 'plan-create' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not create plan', key: 'plan-create' });
    } finally {
      setBusy(null);
    }
  };

  const assign = async (planId: string) => {
    setBusy(`assign:${planId}`);
    try {
      const response = await fetch('/api/admin/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignPlanId: planId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        notify.error(payload.error || 'Could not assign plan', { key: 'plan-assign' });
        return;
      }
      setAssigned(planId);
      notify.success('Plan assigned to this workspace.', { key: 'plan-assign' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not assign plan', key: 'plan-assign' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminPage
      icon="plans"
      title="Plans"
      description="How much each plan may generate, and which members are on it."
      width="wide"
    >
      <AdminCard icon={<Layers className="size-14" aria-hidden />} title="Plan limits">
        <AdminTable
          isEmpty={plans.length === 0}
          empty="No plans yet."
          head={
            <>
              <Th>Plan</Th>
              {FIELDS.map(([, label]) => (
                <Th key={label}>{label}</Th>
              ))}
              <Th>Storage</Th>
              <Th>Flags</Th>
              <Th> </Th>
            </>
          }
        >
          {plans.map((plan) => (
            <Tr key={plan.id}>
              <Td>
                <input
                  className={INPUT_CLASS + ' w-[120px]'}
                  aria-label={`Name for plan ${plan.name}`}
                  defaultValue={plan.name}
                  disabled={busy === plan.id}
                  onBlur={(event) => {
                    if (event.target.value !== plan.name)
                      void patch(plan.id, { name: event.target.value });
                  }}
                />
                <div className="mt-4 text-[11px] text-[var(--studio-faint)]">{plan.key}</div>
              </Td>
              {FIELDS.map(([field, label]) => (
                <Td key={field}>
                  <input
                    type="number"
                    className={INPUT_CLASS + ' w-[72px]'}
                    aria-label={`${label} for plan ${plan.name}`}
                    defaultValue={plan[field]}
                    disabled={busy === plan.id}
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      if (value !== plan[field]) void patch(plan.id, { [field]: value });
                    }}
                  />
                </Td>
              ))}
              <Td>
                <input
                  className={INPUT_CLASS + ' w-[110px]'}
                  aria-label={`Storage limit for plan ${plan.name}`}
                  defaultValue={plan.storageBytesLimit}
                  disabled={busy === plan.id}
                  onBlur={(event) => {
                    if (event.target.value !== plan.storageBytesLimit) {
                      void patch(plan.id, { storageBytesLimit: event.target.value });
                    }
                  }}
                />
              </Td>
              <Td>
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
                    onChange={(event) =>
                      void patch(plan.id, { allowCustomDomain: event.target.checked })
                    }
                  />
                  Domain
                </label>
                <label className="mt-6 flex items-center gap-6">
                  <input
                    type="checkbox"
                    checked={plan.allowGithubSync}
                    disabled={busy === plan.id}
                    onChange={(event) =>
                      void patch(plan.id, { allowGithubSync: event.target.checked })
                    }
                  />
                  GitHub
                </label>
              </Td>
              <Td align="right">
                <StudioButton
                  type="button"
                  variant={assigned === plan.id ? 'primary' : 'ghost'}
                  disabled={busy === `assign:${plan.id}` || assigned === plan.id}
                  onClick={() => void assign(plan.id)}
                >
                  {assigned === plan.id ? 'Assigned' : 'Assign workspace'}
                </StudioButton>
              </Td>
            </Tr>
          ))}
        </AdminTable>
      </AdminCard>

      <AdminCard icon={<Plus className="size-14" aria-hidden />} title="Create plan">
        <form onSubmit={onCreate} className="grid gap-12 sm:grid-cols-3">
          <StudioField id="plan-key" name="key" label="Key" required placeholder="pro-plus" />
          <StudioField id="plan-name" name="name" label="Name" required placeholder="Pro Plus" />
          <StudioField
            id="plan-credits"
            name="monthlyCredits"
            label="Monthly credits"
            type="number"
            defaultValue={200}
          />
          <StudioField
            id="plan-projects"
            name="maxProjects"
            label="Max projects"
            type="number"
            defaultValue={10}
          />
          <StudioField
            id="plan-live"
            name="maxLiveSites"
            label="Max live sites"
            type="number"
            defaultValue={2}
          />
          <StudioField
            id="plan-preview"
            name="maxPreviewSites"
            label="Max preview sites"
            type="number"
            defaultValue={5}
          />
          <StudioField
            id="plan-members"
            name="maxMembers"
            label="Max members"
            type="number"
            defaultValue={5}
          />
          <StudioField
            id="plan-sandboxes"
            name="maxConcurrentSandboxes"
            label="Max concurrent sandboxes"
            type="number"
            defaultValue={2}
          />
          <StudioField
            id="plan-retention"
            name="checkpointRetentionDays"
            label="Checkpoint retention (days)"
            type="number"
            defaultValue={14}
          />
          <StudioField
            id="plan-storage"
            name="storageBytesLimit"
            label="Storage limit (bytes)"
            defaultValue="1073741824"
          />
          <div className="sm:col-span-3">
            <StudioButton type="submit" variant="primary" disabled={busy === 'create'}>
              {busy === 'create' ? 'Creating…' : 'Create plan'}
            </StudioButton>
          </div>
        </form>
      </AdminCard>
    </AdminPage>
  );
}
