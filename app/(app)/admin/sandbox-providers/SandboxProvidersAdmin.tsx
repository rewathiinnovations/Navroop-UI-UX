'use client';

import { FormEvent, useEffect, useState } from 'react';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import PageTabs from '@/components/app/studio/PageTabs';
import { adminTabs } from '../plans/PlansAdmin';
import {
  ADD_PROVIDER_LABEL,
  DEFAULT_ORDER_NOTE,
  FREE_FIRST_STRATEGY_HELP,
  LAST_ACTIVE_DEACTIVATE_WARNING,
  credentialFields,
  type SandboxDriverId,
} from '@/lib/sandbox/provider';
import { formatProviderTestResult, TEST_SCOPE } from './provider-test';
import {
  providersFromPayload,
  readApiError,
  type SandboxProvidersAdminPayload,
} from './provider-table';

/**
 * Multiple configs are for genuinely different providers or legitimately
 * separate accounts (dev vs prod). Creating several free accounts with one
 * provider to extend a free allowance breaks that provider's terms and risks
 * all being closed at once.
 */

type Payload = SandboxProvidersAdminPayload;

/**
 * `leakedSandbox` is non-null on any failure path where the VM outlived the test, so this
 * line is driven by the leak alone and not by `failedAt`. A leak costs money, so it is shown
 * at the same severity as a page error while the failure itself stays muted.
 */
function leakWarningLine(leaked: unknown): string {
  if (leaked === null || typeof leaked !== 'object') return '';
  const sandboxId =
    'sandboxId' in leaked && typeof leaked.sandboxId === 'string' && leaked.sandboxId ? leaked.sandboxId : null;
  const shutdownError = 'error' in leaked && typeof leaked.error === 'string' && leaked.error ? leaked.error : 'Unknown error';
  const where = sandboxId
    ? `Check the provider dashboard for sandbox ${sandboxId}.`
    : 'It could not be identified, so check the provider dashboard for any recent sandbox.';
  return `A test VM may still be running and billing. ${where} Shutdown failed: ${shutdownError}.`;
}

const ACTION_CLASS = 'min-h-0 h-auto shrink-0 px-10 py-4 text-[12px]';

export default function SandboxProvidersAdmin({ initial }: { initial: SandboxProvidersAdminPayload }) {
  const [data, setData] = useState<Payload>(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [driver, setDriver] = useState<SandboxDriverId>('e2b');
  const [testResult, setTestResult] = useState<string>('');
  const [testLeak, setTestLeak] = useState<string>('');
  const rows = providersFromPayload(data);

  const load = async () => {
    try {
      const response = await fetch('/api/admin/sandbox-providers');
      if (response.status === 403) {
        window.location.replace('/dashboard');
        return;
      }
      const payload = await response.json();
      if (!response.ok) {
        setError(readApiError(payload, 'Could not load providers'));
        return;
      }
      setData(payload);
    } catch {
      setError('Could not load providers');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy('create');
    setError('');
    try {
      const response = await fetch('/api/admin/sandbox-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.get('name'),
          driver,
          creditType: form.get('creditType'),
          creditTotalUsd: form.get('creditTotalUsd') || null,
          creditResetsAt: form.get('creditResetsAt') || null,
          apiKey: form.get('apiKey'),
          tokenId: form.get('tokenId'),
          tokenSecret: form.get('tokenSecret'),
          apiUrl: form.get('apiUrl'),
          cpu: form.get('cpu'),
          memoryGiB: form.get('memoryGiB'),
          region: form.get('region'),
          timeoutMs: form.get('timeoutMs'),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(readApiError(payload, 'Could not add provider'));
        return;
      }
      event.currentTarget.reset();
      await load();
    } finally {
      setBusy(null);
    }
  };

  const deactivate = async (id: string, confirm = false) => {
    setBusy(id);
    setError('');
    try {
      const response = await fetch(`/api/admin/sandbox-providers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false, confirm }),
      });
      const payload = await response.json();
      if (response.status === 409 && payload.needsConfirm) {
        if (window.confirm(payload.warning || LAST_ACTIVE_DEACTIVATE_WARNING)) {
          await deactivate(id, true);
        }
        return;
      }
      if (!response.ok) {
        setError(readApiError(payload, 'Could not update provider'));
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  const test = async (id: string) => {
    setBusy(`test:${id}`);
    setTestResult('');
    setTestLeak('');
    try {
      const response = await fetch(`/api/admin/sandbox-providers/${id}/test`, { method: 'POST' });
      const payload = await response.json();
      setTestLeak(leakWarningLine(payload.leakedSandbox ?? null));
      const message =
        typeof payload.message === 'string' && payload.message
          ? payload.message
          : formatProviderTestResult({
              driver: typeof payload.driver === 'string' ? payload.driver : '',
              ok: payload.ok === true,
              failedAt: typeof payload.failedAt === 'string' ? payload.failedAt : null,
              error: typeof payload.error === 'string' ? payload.error : null,
              previewUrl: typeof payload.previewUrl === 'string' ? payload.previewUrl : null,
              leakedSandbox: payload.leakedSandbox ?? null,
            });
      setTestResult(message);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const setStrategy = async (strategy: string) => {
    setBusy('strategy');
    await fetch('/api/admin/sandbox-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy }),
    });
    await load();
    setBusy(null);
  };

  const move = async (index: number, direction: -1 | 1) => {
    if (!data) return;
    const next = [...data.providers];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    if (next[index].creditType !== next[target].creditType) return;
    const [row] = next.splice(index, 1);
    next.splice(target, 0, row);
    setBusy('order');
    await fetch('/api/admin/sandbox-providers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: next.map((item) => item.id) }),
    });
    await load();
    setBusy(null);
  };

  const fields = credentialFields(driver);

  return (
    <StudioShell variant="workspace">
      <PageTabs items={adminTabs('sandbox-providers')} />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-20 px-20 py-20">
        <div>
          <h1 className="text-[22px] font-semibold text-[var(--studio-fg)]">Sandbox providers</h1>
          <p className="mt-8 text-[13px] text-[var(--studio-muted)]">{DEFAULT_ORDER_NOTE}</p>
          {data.nextPickReason ? (
            <p className="mt-8 text-[13px] text-[var(--studio-muted)]">Next pick: {data.nextPickReason}</p>
          ) : null}
          <p className="mt-8 text-[13px] text-[var(--studio-muted)]">{TEST_SCOPE}</p>
          <p className="mt-8 text-[12px] text-[var(--studio-faint)]">
            Multiple configs are for genuinely different providers or legitimately separate accounts (dev vs prod).
            Creating several free accounts with one provider to extend a free allowance breaks that provider&apos;s
            terms and risks all being closed at once.
          </p>
        </div>

        {error && <p className="text-[13px] text-red-600">{error}</p>}
        {testResult && <p className="text-[13px] text-[var(--studio-muted)]">{testResult}</p>}
        {testLeak && <p className="text-[13px] text-red-600">{testLeak}</p>}

        <section>
          <h2 className="mb-8 text-[15px] font-medium">Strategy</h2>
          <p className="mb-8 text-[13px] text-[var(--studio-muted)]">{FREE_FIRST_STRATEGY_HELP}</p>
          <div className="flex flex-col gap-8">
            {(data?.strategies || []).map((item) => (
              <label key={item.id} className="flex items-start gap-8 text-[13px]">
                <input
                  type="radio"
                  name="strategy"
                  checked={item.selected}
                  onChange={() => void setStrategy(item.id)}
                  disabled={busy === 'strategy'}
                />
                <span>
                  <strong className="capitalize">{item.id.replace('_', ' ')}</strong>
                  {' — '}
                  {item.help}
                </span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-8 text-[15px] font-medium">Providers</h2>
          <div className="overflow-x-auto rounded-12 border border-[var(--studio-line)]">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-[var(--studio-surface)] text-[11px] uppercase tracking-[0.06em] text-[var(--studio-faint)]">
                <tr>
                  <th className="px-12 py-10">Name</th>
                  <th className="px-12 py-10">Driver</th>
                  <th className="px-12 py-10">Credit</th>
                  <th className="px-12 py-10">Health</th>
                  <th className="px-12 py-10">Usage</th>
                  <th className="px-12 py-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.id} className="border-t border-[var(--studio-line)]">
                    <td className="whitespace-nowrap px-12 py-10">
                      <div className="font-medium">{row.name}</div>
                      <div className="text-[11px] text-[var(--studio-faint)]">{row.secretLabel}</div>
                    </td>
                    <td className="whitespace-nowrap px-12 py-10 uppercase">{row.driver}</td>
                    <td className="whitespace-nowrap px-12 py-10">
                      <span className="rounded-full bg-[var(--studio-surface)] px-8 py-2 text-[11px]">
                        {row.creditLabel}
                      </span>
                    </td>
                    <td className="px-12 py-10">
                      <span className="whitespace-nowrap rounded-full bg-[var(--studio-surface)] px-8 py-2 text-[11px]">
                        {row.health}
                      </span>
                      {row.lastError ? (
                        <p className="mt-4 max-w-280 text-[11px] text-[var(--studio-danger)]">{row.lastError}</p>
                      ) : null}
                    </td>
                    <td className="px-12 py-10">
                      <div className="h-6 w-120 overflow-hidden rounded-full bg-[var(--studio-skeleton)]">
                        <div
                          className="h-full bg-[var(--studio-accent)]"
                          style={{ width: `${row.usagePercent}%` }}
                        />
                      </div>
                      {row.creditType === 'one_time' && (
                        <p className="mt-4 text-[11px] text-[var(--studio-faint)]">
                          Remaining pool
                          {row.monthsLabel ? ` · ${row.monthsLabel}` : ''}
                        </p>
                      )}
                    </td>
                    <td className="px-12 py-10">
                      <div className="flex flex-nowrap items-center gap-6">
                        <StudioButton
                          type="button"
                          className={ACTION_CLASS}
                          onClick={() => void test(row.id)}
                          disabled={busy === `test:${row.id}`}
                        >
                          {row.testLabel}
                        </StudioButton>
                        {row.isActive && (
                          <StudioButton
                            type="button"
                            className={ACTION_CLASS}
                            onClick={() => void deactivate(row.id)}
                            disabled={busy === row.id}
                          >
                            Deactivate
                          </StudioButton>
                        )}
                        <StudioButton type="button" className={ACTION_CLASS} onClick={() => void move(index, -1)}>
                          Up
                        </StudioButton>
                        <StudioButton type="button" className={ACTION_CLASS} onClick={() => void move(index, 1)}>
                          Down
                        </StudioButton>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-12 py-16 text-[13px] text-[var(--studio-muted)]">
                      No sandbox providers configured.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="mb-8 text-[15px] font-medium">{ADD_PROVIDER_LABEL}</h2>
          <form onSubmit={onCreate} className="grid max-w-xl gap-12">
            <label className="text-[13px]">
              Name
              <input name="name" required className="mt-4 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8" />
            </label>
            <label className="text-[13px]">
              Driver
              <select
                value={driver}
                onChange={(event) => setDriver(event.target.value as SandboxDriverId)}
                className="mt-4 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8"
              >
                <option value="e2b">e2b</option>
                <option value="modal">modal</option>
                <option value="daytona">daytona</option>
              </select>
            </label>
            <p className="text-[12px] text-[var(--studio-muted)]">
              {fields.where}{' '}
              <a href={fields.href} className="text-[var(--studio-accent)]" target="_blank" rel="noreferrer">
                Open dashboard
              </a>
            </p>
            {fields.fields.map((field) => (
              <label key={field.key} className="text-[13px]">
                {field.label}
                <input
                  name={field.key}
                  type={field.type}
                  autoComplete="off"
                  className="mt-4 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8"
                />
              </label>
            ))}
            <label className="text-[13px]">
              Credit type
              <select name="creditType" defaultValue="one_time" className="mt-4 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8">
                <option value="recurring_monthly">Monthly free credit</option>
                <option value="one_time">One-time credit</option>
                <option value="paid">Paid</option>
              </select>
            </label>
            <label className="text-[13px]">
              Credit total (USD)
              <input name="creditTotalUsd" type="number" step="0.01" className="mt-4 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8" />
            </label>
            <label className="text-[13px]">
              Reset date
              <input name="creditResetsAt" type="date" className="mt-4 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8" />
            </label>
            <div className="grid grid-cols-2 gap-12">
              <label className="text-[13px]">
                CPU
                <input name="cpu" type="number" defaultValue={1} className="mt-4 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8" />
              </label>
              <label className="text-[13px]">
                Memory (GiB)
                <input name="memoryGiB" type="number" defaultValue={1} className="mt-4 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8" />
              </label>
              <label className="text-[13px]">
                Region
                <input name="region" className="mt-4 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8" />
              </label>
              <label className="text-[13px]">
                Timeout (ms)
                <input name="timeoutMs" type="number" defaultValue={300000} className="mt-4 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8" />
              </label>
            </div>
            <StudioButton type="submit" disabled={busy === 'create'}>
              {ADD_PROVIDER_LABEL}
            </StudioButton>
          </form>
        </section>

        <section>
          <h2 className="mb-8 text-[15px] font-medium">Capability matrix</h2>
          <div className="overflow-x-auto rounded-12 border border-[var(--studio-line)]">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-[var(--studio-surface)] text-[11px] uppercase text-[var(--studio-faint)]">
                <tr>
                  <th className="px-12 py-10">Driver</th>
                  <th className="px-12 py-10">Public preview</th>
                  <th className="px-12 py-10">Snapshots</th>
                  <th className="px-12 py-10">Persistent FS</th>
                  <th className="px-12 py-10">Regions</th>
                </tr>
              </thead>
              <tbody>
                {(data?.capabilities || []).map((row) => (
                  <tr key={row.driver} className="border-t border-[var(--studio-line)]">
                    <td className="px-12 py-10 uppercase">{row.driver}</td>
                    <td className="px-12 py-10">{row.publicPreviewUrl ? 'Yes' : 'No'}</td>
                    <td className="px-12 py-10">{row.snapshots ? 'Yes' : 'No'}</td>
                    <td className="px-12 py-10">{row.persistentFilesystem ? 'Yes' : 'No'}</td>
                    <td className="px-12 py-10">{row.regions.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </StudioShell>
  );
}
