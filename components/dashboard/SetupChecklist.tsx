'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Circle } from 'lucide-react';
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
          className="rounded-8 px-8 py-4 text-[12px] text-[var(--studio-faint)] hover:text-[var(--studio-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
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
            <span className="inline-flex items-center gap-6 text-[var(--studio-fg)]">
              {row.status === 'CONNECTED' ? (
                <Check className="size-14 shrink-0 text-[var(--studio-accent)]" aria-hidden />
              ) : (
                <Circle className="size-14 shrink-0 text-[var(--studio-faint)]" aria-hidden />
              )}
              {row.name}
              <span className="text-[var(--studio-faint)]">{row.statusLabel}</span>
            </span>
            {row.status !== 'CONNECTED' && (
              <Link
                href="/admin/integrations"
                className="rounded-8 text-[var(--studio-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
              >
                Connect
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
