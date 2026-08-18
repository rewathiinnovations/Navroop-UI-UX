'use client';

import { Download, ScrollText } from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import { AdminTable, Td, Th, Tr } from '@/components/admin/AdminTable';
import StatusBanner from '@/components/admin/StatusBanner';
import { FormEvent, useEffect, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
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
      icon="audit"
      title="Audit log"
      description="A record of every administrative and workspace change, and who made it. Secrets are redacted before anything is written here."
      width="wide"
    >
      {error && <StatusBanner tone="error">{error}</StatusBanner>}

      <AdminCard icon={<ScrollText className="size-14" aria-hidden />} title="Entries">
        <form onSubmit={onFilter} className="mb-16 grid gap-10 sm:grid-cols-5">
          <StudioField
            id="audit-actor"
            label="Actor email"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
          />
          <StudioField
            id="audit-action"
            label="Action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          />
          <StudioField
            id="audit-from"
            label="From"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          <StudioField
            id="audit-to"
            label="To"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          <div className="flex items-end gap-8">
            <StudioButton type="submit" variant="primary" disabled={loading}>
              {loading ? 'Loading…' : 'Filter'}
            </StudioButton>
            <StudioButton
              type="button"
              variant="ghost"
              href={`/api/admin/audit?${query()}&format=csv`}
            >
              <Download className="size-14" aria-hidden />
              CSV
            </StudioButton>
          </div>
        </form>

        <AdminTable
          isEmpty={!loading && rows.length === 0}
          empty="No audit entries."
          head={
            <>
              <Th>When</Th>
              <Th>Actor</Th>
              <Th>Action</Th>
              <Th>Target</Th>
              <Th>Change</Th>
            </>
          }
        >
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td muted>{formatAdminDateTime(row.createdAt)}</Td>
              <Td>{row.actorEmail}</Td>
              <Td>{row.action}</Td>
              <Td muted>
                {row.targetType || '—'}
                {row.targetId ? ` ${row.targetId}` : ''}
              </Td>
              <Td muted>{row.diff.length ? row.diff.join(' · ') : '—'}</Td>
            </Tr>
          ))}
        </AdminTable>
      </AdminCard>
    </AdminPage>
  );
}
