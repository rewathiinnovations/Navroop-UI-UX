'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/app/auth/AuthProvider';

type Row = {
  kind: string;
  name: string;
  status: string;
  statusLabel: string;
};

const HIDDEN_KEY = 'navroop_setup_checklist_hidden';

export default function SetupChecklist() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (user?.role !== 'ADMIN') return;
    setHidden(window.localStorage.getItem(HIDDEN_KEY) === '1');
    void fetch('/api/admin/integrations')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.integrations) setRows(data.integrations);
      })
      .catch(() => undefined);
  }, [user?.role]);

  if (user?.role !== 'ADMIN' || hidden || !rows) return null;
  const missing = rows.filter((row) => row.status !== 'CONNECTED');
  if (missing.length === 0) {
    if (typeof window !== 'undefined') window.localStorage.removeItem(HIDDEN_KEY);
    return null;
  }

  return (
    <div className="mb-24 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16">
      <div className="flex items-start justify-between gap-12">
        <div>
          <p className="text-[15px] font-medium text-[var(--studio-fg)]">Publish setup</p>
          <p className="mt-4 text-[13px] text-[var(--studio-muted)]">
            Once all three are connected, you can publish live sites
          </p>
        </div>
        <button
          type="button"
          className="text-[12px] text-[var(--studio-faint)]"
          onClick={() => {
            window.localStorage.setItem(HIDDEN_KEY, '1');
            setHidden(true);
          }}
        >
          Hide
        </button>
      </div>
      <ul className="mt-12 space-y-8">
        {rows.map((row) => (
          <li key={row.kind} className="flex items-center justify-between gap-12 text-[13px]">
            <span className="text-[var(--studio-fg)]">
              {row.status === 'CONNECTED' ? '✓' : '○'} {row.name}
              <span className="ml-8 text-[var(--studio-faint)]">{row.statusLabel}</span>
            </span>
            {row.status !== 'CONNECTED' && (
              <Link href="/admin/integrations" className="text-[var(--studio-accent)]">
                Connect
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
