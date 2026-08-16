'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import UserMenu from './UserMenu';
import { cn } from '@/utils/cn';
import './studio.css';

export default function ProjectBar({
  title,
  saveState,
  onTitleCommit,
  extra,
}: {
  title: string;
  saveState: 'idle' | 'saving' | 'saved' | 'signin';
  onTitleCommit: (title: string) => void;
  extra?: ReactNode;
}) {
  const [draft, setDraft] = useState(title ?? '');

  useEffect(() => {
    setDraft(title ?? '');
  }, [title]);

  const commit = () => {
    const next = draft.trim() || 'Untitled project';
    setDraft(next);
    if (next !== title) onTitleCommit(next);
  };

  return (
    <div className="studio-shell border-b border-[var(--studio-line)] bg-[var(--studio-header-bg)] backdrop-blur-xl">
      <div className="flex items-center justify-between gap-12 px-12 py-8">
        <div className="flex min-w-0 items-center gap-8">
          <Link
            href="/dashboard"
            aria-label="Back to dashboard"
            className="inline-flex size-[44px] items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface)] hover:text-[var(--studio-fg)] transition-colors duration-200"
          >
            <ArrowLeft className="size-18" aria-hidden />
          </Link>
          <input
            value={draft ?? ''}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
            }}
            aria-label="Project name"
            className={cn(
              'min-w-0 max-w-[320px] h-36 px-10 rounded-8 bg-transparent',
              'text-[14px] font-medium text-[var(--studio-fg)]',
              'border border-transparent hover:border-[var(--studio-line)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:border-transparent',
            )}
          />
          <span className="hidden sm:inline text-[12px] text-[var(--studio-faint)]">
            {saveState === 'saving' && 'Saving…'}
            {saveState === 'saved' && 'Saved'}
            {saveState === 'signin' && (
              <Link href="/?auth=login&next=/dashboard" className="text-[var(--studio-accent)] hover:underline">
                Sign in to save
              </Link>
            )}
          </span>
        </div>
        <div className="flex items-center gap-8">
          {extra}
          <UserMenu compact />
        </div>
      </div>
    </div>
  );
}
