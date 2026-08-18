'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Globe, Lock, Trash2 } from 'lucide-react';
import { cn } from '@/utils/cn';
import { notify } from '@/lib/notify';
import {
  addProjectDomain,
  checkProjectDomain,
  emailProjectDomain,
  listProjectDomains,
  makeProjectDomainPrimary,
  removeProjectDomain,
} from '@/lib/domains/actions';
import {
  DNS_PROPAGATION_NOTE,
  PATH_B_COPY,
  type CustomDomainPath,
  type DnsInstruction,
  type PublicCustomDomain,
} from '@/lib/domains/types';

type DomainState = {
  allowed: boolean;
  lockMessage: string | null;
  published: boolean;
  ourZone: string | null;
  publishedHost: string;
  domains: PublicCustomDomain[];
};

function statusLabel(status: PublicCustomDomain['status']) {
  switch (status) {
    case 'ACTIVE':
      return 'Live';
    case 'SSL_PENDING':
      return 'SSL issuing';
    case 'VERIFYING':
      return 'Checking DNS';
    case 'FAILED':
      return 'Failed';
    default:
      return 'Waiting for DNS';
  }
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    notify.success('Copied to clipboard.', { key: 'domain-copy' });
  } catch {
    notify.warning('Could not copy — select the value and copy it by hand.', {
      key: 'domain-copy',
    });
  }
}

function InstructionTable({
  rows,
  onCopied,
}: {
  rows: DnsInstruction[];
  onCopied: (label: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-12 border border-[var(--studio-line)]">
      <table className="w-full text-left text-[12px]">
        <thead className="bg-[var(--studio-surface)] text-[var(--studio-muted)]">
          <tr>
            <th className="px-10 py-8 font-medium">Type</th>
            <th className="px-10 py-8 font-medium">Name</th>
            <th className="px-10 py-8 font-medium">Value</th>
            <th className="px-10 py-8 font-medium">TTL</th>
            <th className="px-10 py-8 font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.type}-${row.name}-${row.value}`}
              className="border-t border-[var(--studio-line)]"
            >
              <td className="px-10 py-8 font-medium text-[var(--studio-fg)]">{row.type}</td>
              <td className="px-10 py-8 text-[var(--studio-muted)]">{row.name}</td>
              <td className="px-10 py-8 break-all text-[var(--studio-fg)]">{row.value}</td>
              <td className="px-10 py-8 text-[var(--studio-muted)]">{row.ttl}</td>
              <td className="px-10 py-8">
                <button
                  type="button"
                  className="inline-flex items-center gap-4 text-[var(--studio-muted)] hover:text-[var(--studio-fg)]"
                  onClick={() => void copyText(row.value).then(() => onCopied(row.value))}
                >
                  <Copy className="size-12" />
                  Copy
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DomainsPanel({ projectId }: { projectId: string }) {
  const [state, setState] = useState<DomainState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [hostname, setHostname] = useState('');
  const [path, setPath] = useState<CustomDomainPath>('B');
  const [busy, setBusy] = useState('');
  const [emailById, setEmailById] = useState<Record<string, string>>({});
  const [confirmById, setConfirmById] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    const result = await listProjectDomains(projectId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setState(result.data);
    setError('');
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    const pending = state?.domains.some(
      (row) => row.status !== 'ACTIVE' && row.status !== 'FAILED',
    );
    if (!pending) return;
    const timer = window.setInterval(() => {
      void load();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [load, state?.domains]);

  /**
   * Every domain mutation funnels through here, so success and failure toasts
   * live in one place rather than at each call site. The inline `error` is left
   * to `load`, where it explains an empty panel.
   */
  const run = async (label: string, done: string, work: () => Promise<void>) => {
    setBusy(label);
    try {
      await work();
      await load();
      notify.success(done, { key: `domain-${label}` });
    } catch (caught) {
      notify.error(caught, { key: `domain-${label}` });
    } finally {
      setBusy('');
    }
  };

  if (loading && !state) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--studio-muted)]">
        Loading domains…
      </div>
    );
  }

  if (state && !state.allowed) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-10 bg-[var(--studio-bg)] px-16 text-center">
        <Lock className="size-20 text-[var(--studio-muted)]" />
        <h2 className="text-[16px] font-semibold text-[var(--studio-fg)]">Custom domains</h2>
        <p className="max-w-sm text-[13px] text-[var(--studio-muted)]">
          {state.lockMessage || 'This feature is not on your plan yet'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--studio-bg)]">
      <div className="border-b border-[var(--studio-line)] px-16 py-12">
        <h2 className="text-[14px] font-semibold text-[var(--studio-fg)]">Domains</h2>
        <p className="text-[12px] text-[var(--studio-faint)]">
          Point a client hostname at a published site. {DNS_PROPAGATION_NOTE}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-16 overflow-auto px-16 py-12">
        {error ? <p className="text-[13px] text-[var(--studio-danger)]">{error}</p> : null}
        {!state?.published ? (
          <p className="text-[13px] text-[var(--studio-muted)]">
            Publish the site first, then add a custom domain.
          </p>
        ) : null}

        <div className="space-y-8">
          <label
            className="block text-[12px] font-medium text-[var(--studio-muted)]"
            htmlFor="domain-hostname"
          >
            Add domain
          </label>
          <input
            id="domain-hostname"
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder="example.com or www.example.com"
            className="h-36 w-full rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-12 text-[13px] text-[var(--studio-fg)]"
          />
        </div>

        <div className="grid gap-12 md:grid-cols-2">
          <button
            type="button"
            onClick={() => setPath('B')}
            className={cn(
              'rounded-14 border p-14 text-left',
              path === 'B'
                ? 'border-[var(--studio-fg)] bg-[var(--studio-surface)]'
                : 'border-[var(--studio-line)]',
            )}
          >
            <p className="text-[13px] font-semibold text-[var(--studio-fg)]">
              Easier — recommended
            </p>
            <p className="mt-6 text-[12px] text-[var(--studio-muted)]">{PATH_B_COPY}</p>
          </button>
          <button
            type="button"
            onClick={() => setPath('A')}
            className={cn(
              'rounded-14 border p-14 text-left',
              path === 'A'
                ? 'border-[var(--studio-fg)] bg-[var(--studio-surface)]'
                : 'border-[var(--studio-line)]',
            )}
          >
            <p className="text-[13px] font-semibold text-[var(--studio-fg)]">
              Keep DNS with the client
            </p>
            <p className="mt-6 text-[12px] text-[var(--studio-muted)]">
              We give you A / CNAME / TXT records to add at their DNS provider.
            </p>
          </button>
        </div>

        <button
          type="button"
          disabled={!hostname.trim() || busy === 'add' || !state?.published}
          onClick={() =>
            void run('add', 'Domain added — DNS changes can take a while.', async () => {
              const result = await addProjectDomain(projectId, { hostname, path });
              if (!result.ok) throw new Error(result.error);
              setHostname('');
            })
          }
          className="inline-flex h-36 items-center rounded-full bg-[var(--studio-fg)] px-14 text-[13px] font-medium text-[var(--studio-bg)] disabled:opacity-50"
        >
          {busy === 'add' ? 'Adding…' : 'Add domain'}
        </button>

        {state?.domains.map((domain) => (
          <article
            key={domain.id}
            className="space-y-12 rounded-14 border border-[var(--studio-line)] p-14"
          >
            <div className="flex flex-wrap items-center justify-between gap-8">
              <div className="flex items-center gap-8">
                <Globe className="size-16 text-[var(--studio-muted)]" />
                <p className="text-[14px] font-semibold text-[var(--studio-fg)]">
                  {domain.hostname}
                </p>
                <span
                  className={cn(
                    'rounded-full px-8 py-2 text-[11px] font-medium',
                    domain.status === 'ACTIVE'
                      ? 'bg-emerald-100 text-emerald-800'
                      : domain.status === 'FAILED'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-[var(--studio-surface)] text-[var(--studio-muted)]',
                  )}
                >
                  {statusLabel(domain.status)}
                </span>
                {domain.isPrimary ? (
                  <span className="rounded-full bg-emerald-100 px-8 py-2 text-[11px] font-medium text-emerald-800">
                    Primary
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-8">
                {domain.status === 'ACTIVE' && !domain.isPrimary ? (
                  <button
                    type="button"
                    className="text-[12px] text-[var(--studio-fg)]"
                    onClick={() =>
                      void run(
                        `primary-${domain.id}`,
                        `${domain.hostname} is now primary.`,
                        async () => {
                          const result = await makeProjectDomainPrimary(projectId, domain.id);
                          if (!result.ok) throw new Error(result.error);
                        },
                      )
                    }
                  >
                    Make primary
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex items-center gap-4 text-[12px] text-[var(--studio-danger)]"
                  onClick={() =>
                    void run(`remove-${domain.id}`, `${domain.hostname} removed.`, async () => {
                      const result = await removeProjectDomain(
                        projectId,
                        domain.id,
                        confirmById[domain.id],
                      );
                      if (!result.ok) throw new Error(result.error);
                    })
                  }
                >
                  <Trash2 className="size-12" />
                  Remove
                </button>
              </div>
            </div>

            {domain.path === 'B' ? (
              <p className="text-[12px] text-[var(--studio-muted)]">
                Path B zone is kept if you remove this domain. Type{' '}
                <strong>{domain.hostname}</strong> to confirm remove.
              </p>
            ) : null}
            {domain.path === 'B' ? (
              <input
                value={confirmById[domain.id] ?? ''}
                onChange={(event) =>
                  setConfirmById((current) => ({ ...current, [domain.id]: event.target.value }))
                }
                placeholder={domain.hostname}
                className="h-32 w-full rounded-8 border border-[var(--studio-line)] px-10 text-[12px]"
              />
            ) : null}

            <ol className="grid gap-8 sm:grid-cols-4">
              {domain.timeline.map((step) => (
                <li key={step.id} className="flex items-center gap-6 text-[12px]">
                  <span
                    className={cn(
                      'flex size-18 items-center justify-center rounded-full',
                      step.done
                        ? 'bg-emerald-600 text-white'
                        : 'bg-[var(--studio-surface)] text-[var(--studio-muted)]',
                    )}
                  >
                    {step.done ? <Check className="size-10" /> : null}
                  </span>
                  <span
                    className={
                      step.current
                        ? 'font-medium text-[var(--studio-fg)]'
                        : 'text-[var(--studio-muted)]'
                    }
                  >
                    {step.label}
                  </span>
                </li>
              ))}
            </ol>

            {domain.lastError ? (
              <p className="rounded-10 bg-red-50 px-10 py-8 text-[12px] text-red-800">
                {domain.lastError}
              </p>
            ) : null}

            <InstructionTable rows={domain.instructions} onCopied={(value) => setCopied(value)} />
            <div className="flex flex-wrap items-center gap-8">
              <button
                type="button"
                className="text-[12px] text-[var(--studio-fg)]"
                onClick={() =>
                  void copyText(
                    domain.instructions
                      .map((row) => `${row.type} ${row.name} ${row.value} ${row.ttl}`)
                      .join('\n'),
                  ).then(() => setCopied('all'))
                }
              >
                Copy all
              </button>
              {copied ? (
                <span className="text-[11px] text-[var(--studio-muted)]">Copied</span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-end gap-8">
              <label className="min-w-[200px] flex-1 text-[12px] text-[var(--studio-muted)]">
                Email the client
                <input
                  value={emailById[domain.id] ?? ''}
                  onChange={(event) =>
                    setEmailById((current) => ({ ...current, [domain.id]: event.target.value }))
                  }
                  placeholder="client@example.com"
                  className="mt-4 h-32 w-full rounded-8 border border-[var(--studio-line)] px-10 text-[12px] text-[var(--studio-fg)]"
                />
              </label>
              <button
                type="button"
                className="h-32 rounded-full border border-[var(--studio-line)] px-12 text-[12px]"
                onClick={() =>
                  void run(
                    `email-${domain.id}`,
                    'Instructions emailed to the client.',
                    async () => {
                      const result = await emailProjectDomain(
                        projectId,
                        domain.id,
                        emailById[domain.id] ?? '',
                      );
                      if (!result.ok) throw new Error(result.error);
                    },
                  )
                }
              >
                Email the client
              </button>
            </div>
            <p className="text-[11px] text-[var(--studio-faint)]">
              {domain.path === 'B' ? PATH_B_COPY : DNS_PROPAGATION_NOTE}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
