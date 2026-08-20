'use client';

import { useEffect, useState } from 'react';
import { fetchJson, toMessage } from '@/lib/notify';
import StudioShell from '@/components/app/studio/StudioShell';
import PageTabs from '@/components/app/studio/PageTabs';
import { SkeletonLines } from '@/components/admin/AdminSkeleton';
import { formatStorageBytes } from '@/lib/storage/format';

type UsageData = {
  used: number;
  limit: number;
  resetAt: string;
  storageBytes: number;
  storageLimitBytes: number;
  byAction: Record<string, number>;
  members: Array<{
    userId: string;
    name: string;
    email: string;
    credits: number;
    actions: Record<string, number>;
  }>;
  workspaceTotal: number;
  unattributed?: number;
  isAdmin: boolean;
};

export default function SettingsUsagePage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState('');
  // F-428: the page had no loading flag, so a slow or failing request rendered
  // the heading and the tab strip over blank space with no signal it was
  // working. `fetchJson` reads the API's `{ error }` envelope, so a 401/500 no
  // longer collapses into a generic message that discards what the server said.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await fetchJson<UsageData>('/api/settings/usage');
        if (!cancelled) setData(payload);
      } catch (cause) {
        if (!cancelled) setError(toMessage(cause, 'Could not load usage'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reset = data ? new Date(data.resetAt) : null;
  const storageRatio =
    data && data.storageLimitBytes > 0
      ? Math.min(data.storageBytes / data.storageLimitBytes, 1)
      : 0;

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[720px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
          Settings
        </h1>
        <PageTabs
          items={[
            { href: '/settings/profile', label: 'Profile' },
            { href: '/settings/api-keys', label: 'API Keys' },
            { href: '/settings/skills', label: 'Skills' },
            { href: '/settings/usage', label: 'Usage', active: true },
          ]}
        />

        {error && (
          <p className="text-[13px] text-[var(--studio-danger)]" role="alert">
            {error}
          </p>
        )}

        {loading && <SkeletonLines lines={5} />}

        {data && (
          <div className="space-y-28">
            <section>
              <h2 className="text-[18px] font-medium text-[var(--studio-fg)]">This period</h2>
              <p className="mt-6 text-[13px] text-[var(--studio-muted)]">
                {data.used} / {data.limit} credits
                {reset && !Number.isNaN(reset.getTime())
                  ? ` · resets ${reset.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}`
                  : ''}
              </p>
              <p className="mt-4 text-[12px] text-[var(--studio-faint)]">
                Workspace total: {data.workspaceTotal} credits
                {(data.unattributed ?? 0) > 0
                  ? ` · plus ${data.unattributed} from removed members or deleted history`
                  : ''}
              </p>
            </section>

            <section>
              <h2 className="mb-10 text-[18px] font-medium text-[var(--studio-fg)]">By action</h2>
              <ul className="space-y-6 text-[13px] text-[var(--studio-muted)]">
                {Object.keys(data.byAction).length === 0 && <li>No credit use yet this period.</li>}
                {Object.entries(data.byAction).map(([action, credits]) => (
                  <li key={action} className="flex justify-between">
                    <span className="capitalize">{action}</span>
                    <span>{credits}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className="mb-10 text-[18px] font-medium text-[var(--studio-fg)]">
                {data.isAdmin ? 'Members' : 'Your usage'}
              </h2>
              <div className="overflow-x-auto rounded-12 border border-[var(--studio-line)]">
                <table className="w-full text-left text-[13px]">
                  <thead className="border-b border-[var(--studio-line)] text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
                    <tr>
                      <th className="px-14 py-10 font-medium">Member</th>
                      <th className="px-14 py-10 font-medium">Credits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.members.map((member) => (
                      <tr
                        key={member.userId}
                        className="border-b border-[var(--studio-line)] last:border-0"
                      >
                        <td className="px-14 py-12">
                          <div className="font-medium text-[var(--studio-fg)]">{member.name}</div>
                          <div className="text-[12px] text-[var(--studio-faint)]">
                            {member.email}
                          </div>
                        </td>
                        <td className="px-14 py-12 text-[var(--studio-muted)]">{member.credits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="text-[18px] font-medium text-[var(--studio-fg)]">Storage</h2>
              <p className="mt-6 text-[13px] text-[var(--studio-muted)]">
                {formatStorageBytes(data.storageBytes)} of{' '}
                {formatStorageBytes(data.storageLimitBytes)}
              </p>
              <div
                className="mt-8 h-8 overflow-hidden rounded-full bg-[var(--studio-skeleton)]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={data.storageLimitBytes}
                aria-valuenow={data.storageBytes}
                aria-label="Workspace storage used"
              >
                <div
                  className="h-full rounded-full bg-[var(--studio-accent)]"
                  style={{
                    width: `${Math.max(storageRatio * 100, data.storageBytes > 0 ? 2 : 0)}%`,
                  }}
                />
              </div>
            </section>
          </div>
        )}
      </main>
    </StudioShell>
  );
}
