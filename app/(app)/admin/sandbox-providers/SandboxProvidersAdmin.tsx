'use client';

import { ArrowUpDown, ChevronDown, ChevronUp, Cpu, Plus, Table2 } from 'lucide-react';
import Accordion from '@/components/admin/Accordion';
import AdminCard from '@/components/admin/AdminCard';
import ConfirmAction from '@/components/admin/ConfirmAction';
import AdminPage from '@/components/admin/AdminPage';
import { AdminTable, Td, Th, Tr } from '@/components/admin/AdminTable';
import StatusBanner from '@/components/admin/StatusBanner';
import { FormEvent, useEffect, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import StudioSelect from '@/components/app/studio/StudioSelect';
import { fetchJson, notify, toMessage } from '@/lib/notify';
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
    'sandboxId' in leaked && typeof leaked.sandboxId === 'string' && leaked.sandboxId
      ? leaked.sandboxId
      : null;
  const shutdownError =
    'error' in leaked && typeof leaked.error === 'string' && leaked.error
      ? leaked.error
      : 'Unknown error';
  const where = sandboxId
    ? `Check the provider dashboard for sandbox ${sandboxId}.`
    : 'It could not be identified, so check the provider dashboard for any recent sandbox.';
  return `A test VM may still be running and billing. ${where} Shutdown failed: ${shutdownError}.`;
}

const ACTION_CLASS = 'min-h-0 h-32 shrink-0 px-10 py-4 text-[12px]';
const FORM_INPUT_CLASS =
  'mt-4 w-full h-40 rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] px-12 text-[14px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]';

export default function SandboxProvidersAdmin({
  initial,
}: {
  initial: SandboxProvidersAdminPayload;
}) {
  const [data, setData] = useState<Payload>(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [driver, setDriver] = useState<SandboxDriverId>('e2b');
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
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy('create');
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
        notify.error(readApiError(payload, 'Could not add provider'), { key: 'provider-create' });
        return;
      }
      formElement.reset();
      await load();
      notify.success('Provider added.', { key: 'provider-create' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not add provider', key: 'provider-create' });
    } finally {
      setBusy(null);
    }
  };

  const deactivate = async (id: string, confirm = false) => {
    setBusy(id);
    try {
      const response = await fetch(`/api/admin/sandbox-providers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false, confirm }),
      });
      const payload = await response.json();
      if (response.status === 409 && payload.needsConfirm) {
        // The row didn't look like the last active provider when it rendered,
        // but the server says it is now (another admin deactivated the rest).
        // Surface the warning; the refreshed table renders a ConfirmAction.
        notify.warning(payload.warning || LAST_ACTIVE_DEACTIVATE_WARNING, {
          key: `provider-${id}`,
          autoClose: 10000,
        });
        await load();
        return;
      }
      if (!response.ok) {
        notify.error(readApiError(payload, 'Could not update provider'), {
          key: `provider-${id}`,
        });
        return;
      }
      await load();
      notify.success('Provider deactivated.', { key: `provider-${id}` });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not update provider', key: `provider-${id}` });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      const response = await fetch(`/api/admin/sandbox-providers/${id}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409 && payload.needsConfirm) {
        // The server refuses to delete the last active provider outright —
        // deactivate (which has its own confirm) or add another provider first.
        notify.warning(payload.warning || LAST_ACTIVE_DEACTIVATE_WARNING, {
          key: `provider-${id}`,
          autoClose: 10000,
        });
        return;
      }
      if (!response.ok) {
        notify.error(readApiError(payload, 'Could not delete provider'), {
          key: `provider-${id}`,
        });
        return;
      }
      await load();
      notify.success('Provider deleted.', { key: `provider-${id}` });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not delete provider', key: `provider-${id}` });
    } finally {
      setBusy(null);
    }
  };

  // Boots a real VM on the provider, so this can take a while — the pending
  // toast is settled in place with the verdict.
  const test = async (id: string) => {
    setBusy(`test:${id}`);
    setTestLeak('');
    const toastId = notify.loading('Starting a test sandbox…');
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
      notify.settle(toastId, payload.ok === true ? 'success' : 'error', message, {
        autoClose: 10000,
      });
      await load();
    } catch (cause) {
      notify.settle(toastId, 'error', toMessage(cause, 'The provider test failed'));
    } finally {
      setBusy(null);
    }
  };

  const setStrategy = async (strategy: string) => {
    setBusy('strategy');
    try {
      await fetchJson('/api/admin/sandbox-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy }),
      });
      await load();
      notify.success('Selection strategy updated.', { key: 'provider-strategy' });
    } catch (cause) {
      notify.error(cause, {
        fallback: 'Could not change the strategy',
        key: 'provider-strategy',
      });
    } finally {
      setBusy(null);
    }
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
    try {
      await fetchJson('/api/admin/sandbox-providers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: next.map((item) => item.id) }),
      });
      await load();
      notify.success('Provider order saved.', { key: 'provider-order' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not reorder providers', key: 'provider-order' });
    } finally {
      setBusy(null);
    }
  };

  const fields = credentialFields(driver);

  return (
    <AdminPage
      icon="sandbox-providers"
      title="Sandbox providers"
      description="Which service runs generated code, and the order they are tried when one is unavailable."
      width="wide"
    >
      <div className="space-y-6 text-[13px] text-[var(--studio-muted)]">
        <p>{DEFAULT_ORDER_NOTE}</p>
        {data.nextPickReason ? <p>Next pick: {data.nextPickReason}</p> : null}
        <p>{TEST_SCOPE}</p>
        <p className="text-[12px] text-[var(--studio-faint)]">
          Multiple configs are for genuinely different providers or legitimately separate accounts
          (dev vs prod). Creating several free accounts with one provider to extend a free allowance
          breaks that provider&apos;s terms and risks all being closed at once.
        </p>
      </div>

      {error && <StatusBanner tone="error">{error}</StatusBanner>}
      {/* Sticky on purpose: a leaked VM keeps billing, so this must not
          auto-dismiss the way the test result toast does. */}
      {testLeak && <StatusBanner tone="error">{testLeak}</StatusBanner>}

      <AdminCard icon={<ArrowUpDown className="size-14" aria-hidden />} title="Strategy">
        <p className="mb-12 text-[13px] text-[var(--studio-muted)]">{FREE_FIRST_STRATEGY_HELP}</p>
        <div className="flex flex-col gap-8">
          {(data?.strategies || []).map((item) => (
            <label key={item.id} className="flex items-start gap-8 text-[13px]">
              <input
                type="radio"
                name="strategy"
                checked={item.selected}
                onChange={() => void setStrategy(item.id)}
                disabled={busy === 'strategy'}
                className="mt-2"
              />
              <span>
                <strong className="capitalize text-[var(--studio-fg)]">
                  {item.id.replace('_', ' ')}
                </strong>
                {' — '}
                {item.help}
              </span>
            </label>
          ))}
        </div>
      </AdminCard>

      <AdminCard icon={<Cpu className="size-14" aria-hidden />} title="Providers">
        <AdminTable
          isEmpty={rows.length === 0}
          empty="No sandbox providers configured."
          head={
            <>
              <Th>Name</Th>
              <Th>Driver</Th>
              <Th>Credit</Th>
              <Th>Health</Th>
              <Th>Usage</Th>
              <Th align="right"> </Th>
            </>
          }
        >
          {rows.map((row, index) => (
            <Tr key={row.id}>
              <Td>
                <div className="font-medium text-[var(--studio-fg)]">{row.name}</div>
                <div className="text-[11px] text-[var(--studio-faint)]">{row.secretLabel}</div>
              </Td>
              <Td className="uppercase" muted>
                {row.driver}
              </Td>
              <Td>
                <span className="rounded-full border border-[var(--studio-line)] px-8 py-2 text-[11px] text-[var(--studio-muted)]">
                  {row.creditLabel}
                </span>
              </Td>
              <Td>
                <span className="whitespace-nowrap rounded-full border border-[var(--studio-line)] px-8 py-2 text-[11px] text-[var(--studio-muted)]">
                  {row.health}
                </span>
                {row.lastError ? (
                  <p className="mt-4 max-w-280 text-[11px] text-[var(--studio-danger)]">
                    {row.lastError}
                  </p>
                ) : null}
              </Td>
              <Td>
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
              </Td>
              <Td align="right">
                <div className="flex flex-nowrap items-center justify-end gap-6">
                  <StudioButton
                    type="button"
                    className={ACTION_CLASS}
                    onClick={() => void test(row.id)}
                    disabled={busy === `test:${row.id}`}
                  >
                    {row.testLabel}
                  </StudioButton>
                  {row.isActive &&
                    (rows.filter((r) => r.isActive).length === 1 ? (
                      <ConfirmAction
                        label="Deactivate"
                        title={`Deactivate ${row.name}?`}
                        body={LAST_ACTIVE_DEACTIVATE_WARNING}
                        confirmLabel="Deactivate"
                        busyLabel="Deactivating…"
                        disabled={busy === row.id}
                        onConfirm={() => deactivate(row.id, true)}
                      />
                    ) : (
                      <StudioButton
                        type="button"
                        variant="danger"
                        className={ACTION_CLASS}
                        onClick={() => void deactivate(row.id)}
                        disabled={busy === row.id}
                      >
                        Deactivate
                      </StudioButton>
                    ))}
                  <ConfirmAction
                    label="Delete"
                    title={`Delete ${row.name}?`}
                    body="The row and its stored credential are removed permanently. Projects that used it fall back to the routing strategy on their next boot. Usage history on the row is lost — the provider dashboard stays authoritative for billing."
                    confirmLabel="Delete"
                    busyLabel="Deleting…"
                    triggerClassName={ACTION_CLASS}
                    disabled={busy === row.id}
                    onConfirm={() => remove(row.id)}
                  />
                  <StudioButton
                    type="button"
                    variant="ghost"
                    aria-label={`Move ${row.name} up`}
                    className={ACTION_CLASS + ' !px-8'}
                    onClick={() => void move(index, -1)}
                  >
                    <ChevronUp className="size-13" aria-hidden />
                  </StudioButton>
                  <StudioButton
                    type="button"
                    variant="ghost"
                    aria-label={`Move ${row.name} down`}
                    className={ACTION_CLASS + ' !px-8'}
                    onClick={() => void move(index, 1)}
                  >
                    <ChevronDown className="size-13" aria-hidden />
                  </StudioButton>
                </div>
              </Td>
            </Tr>
          ))}
        </AdminTable>
      </AdminCard>

      <Accordion
        icon={<Plus className="size-14" aria-hidden />}
        title={ADD_PROVIDER_LABEL}
        description="Connect another E2B, Modal, or Daytona account."
      >
        <form onSubmit={onCreate} className="grid max-w-xl gap-12">
          <StudioField id="provider-name" name="name" label="Name" required />
          <StudioSelect
            id="provider-driver"
            label="Driver"
            value={driver}
            onChange={(event) => setDriver(event.target.value as SandboxDriverId)}
          >
            <option value="e2b">e2b</option>
            <option value="modal">modal</option>
            <option value="daytona">daytona</option>
          </StudioSelect>
          <p className="text-[12px] text-[var(--studio-muted)]">
            {fields.where}{' '}
            <a
              href={fields.href}
              className="text-[var(--studio-accent)]"
              target="_blank"
              rel="noreferrer"
            >
              Open dashboard
            </a>
          </p>
          {fields.fields.map((field) => (
            <StudioField
              key={field.key}
              id={`provider-${field.key}`}
              name={field.key}
              label={field.label}
              type={field.type}
              autoComplete="off"
            />
          ))}
          <StudioSelect
            id="provider-credit-type"
            name="creditType"
            label="Credit type"
            defaultValue="one_time"
          >
            <option value="recurring_monthly">Monthly free credit</option>
            <option value="one_time">One-time credit</option>
            <option value="paid">Paid</option>
          </StudioSelect>
          <StudioField
            id="provider-credit-total"
            name="creditTotalUsd"
            label="Credit total (USD)"
            type="number"
            step="0.01"
          />
          <StudioField
            id="provider-credit-resets"
            name="creditResetsAt"
            label="Reset date"
            type="date"
          />
          <div className="grid grid-cols-2 gap-12">
            <StudioField id="provider-cpu" name="cpu" label="CPU" type="number" defaultValue={1} />
            <StudioField
              id="provider-memory"
              name="memoryGiB"
              label="Memory (GiB)"
              type="number"
              defaultValue={1}
            />
            <StudioField id="provider-region" name="region" label="Region" />
            <StudioField
              id="provider-timeout"
              name="timeoutMs"
              label="Timeout (ms)"
              type="number"
              defaultValue={300000}
            />
          </div>
          <div>
            <StudioButton type="submit" disabled={busy === 'create'}>
              {busy === 'create' ? 'Adding…' : ADD_PROVIDER_LABEL}
            </StudioButton>
          </div>
        </form>
      </Accordion>

      <AdminCard icon={<Table2 className="size-14" aria-hidden />} title="Capability matrix">
        <AdminTable
          isEmpty={(data?.capabilities || []).length === 0}
          empty="No capability data."
          head={
            <>
              <Th>Driver</Th>
              <Th>Public preview</Th>
              <Th>Snapshots</Th>
              <Th>Persistent FS</Th>
              <Th>Regions</Th>
            </>
          }
        >
          {(data?.capabilities || []).map((row) => (
            <Tr key={row.driver}>
              <Td className="uppercase">{row.driver}</Td>
              <Td muted>{row.publicPreviewUrl ? 'Yes' : 'No'}</Td>
              <Td muted>{row.snapshots ? 'Yes' : 'No'}</Td>
              <Td muted>{row.persistentFilesystem ? 'Yes' : 'No'}</Td>
              <Td muted>{row.regions.join(', ')}</Td>
            </Tr>
          ))}
        </AdminTable>
      </AdminCard>
    </AdminPage>
  );
}
