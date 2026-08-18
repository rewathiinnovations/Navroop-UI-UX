'use client';

import AdminPage from '@/components/admin/AdminPage';
import { FormEvent, useEffect, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import { formatAdminDateTime } from '../format-admin-date';

type AuditRow = {
  id: string;
  actorEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  createdAt: string;
  diff: string[];
};

export default function AuditAdmin() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = () => {
    const params = new URLSearchParams();
    if (actor.trim()) params.set('actor', actor.trim());
    if (action.trim()) params.set('action', action.trim());
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/admin/audit?${query()}`);
      if (response.status === 403) {
        window.location.replace('/dashboard');
        return;
      }
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || 'Could not load audit log');
        return;
      }
      setRows(payload.rows || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onFilter = (event: FormEvent) => {
    event.preventDefault();
    void load();
  };

  return (
    <AdminPage
      title="Audit log"
      description="A record of every administrative and workspace change, and who made it. Secrets are redacted before anything is written here."
      width="wide"
    >
      <form onSubmit={onFilter} className="grid gap-10 sm:grid-cols-5">
        <input
          value={actor}
          onChange={(event) => setActor(event.target.value)}
          placeholder="Actor email"
          className="h-40 rounded-10 border border-[var(--studio-line)] px-12 text-[13px]"
        />
        <input
          value={action}
          onChange={(event) => setAction(event.target.value)}
          placeholder="Action"
          className="h-40 rounded-10 border border-[var(--studio-line)] px-12 text-[13px]"
        />
        <input
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="h-40 rounded-10 border border-[var(--studio-line)] px-12 text-[13px]"
        />
        <input
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          className="h-40 rounded-10 border border-[var(--studio-line)] px-12 text-[13px]"
        />
        <div className="flex gap-8">
          <StudioButton type="submit" variant="primary" disabled={loading}>
            {loading ? 'Loading…' : 'Filter'}
          </StudioButton>
          <a
            href={`/api/admin/audit?${query()}&format=csv`}
            className="inline-flex h-40 items-center rounded-10 border border-[var(--studio-line)] px-12 text-[13px] text-[var(--studio-fg)]"
          >
            Export CSV
          </a>
        </div>
      </form>

      {error ? <p className="text-[13px] text-red-600">{error}</p> : null}

      <div className="overflow-x-auto rounded-12 border border-[var(--studio-line)]">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-[var(--studio-surface)] text-[var(--studio-muted)]">
            <tr>
              <th className="px-12 py-10 font-medium">When</th>
              <th className="px-12 py-10 font-medium">Actor</th>
              <th className="px-12 py-10 font-medium">Action</th>
              <th className="px-12 py-10 font-medium">Target</th>
              <th className="px-12 py-10 font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={5} className="px-12 py-16 text-[var(--studio-faint)]">
                  No audit entries
                </td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-[var(--studio-line)]">
                <td className="whitespace-nowrap px-12 py-10 text-[var(--studio-muted)]">
                  {formatAdminDateTime(row.createdAt)}
                </td>
                <td className="px-12 py-10">{row.actorEmail}</td>
                <td className="px-12 py-10">{row.action}</td>
                <td className="px-12 py-10 text-[var(--studio-muted)]">
                  {row.targetType || '—'}
                  {row.targetId ? ` ${row.targetId}` : ''}
                </td>
                <td className="px-12 py-10 text-[var(--studio-muted)]">
                  {row.diff.length ? row.diff.join(' · ') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminPage>
  );
}
