'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { WorkspacePlan } from './types';

export default function PlanCard({
  plan,
  approving,
  onApprove,
}: {
  plan: WorkspacePlan;
  approving?: boolean;
  onApprove?: () => void;
}) {
  const pending = plan.status === 'PENDING';
  const approved = plan.status === 'APPROVED';

  return (
    <article
      className={cn(
        'mb-16 overflow-hidden rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)]',
        approved && 'opacity-70',
      )}
    >
      <div className={cn('px-14 py-12', approved && 'py-10')}>
        <div className="mb-8 flex items-center justify-between gap-8">
          <h3
            className={cn(
              'font-medium text-[var(--studio-fg)]',
              pending ? 'text-[13px]' : 'text-[12px]',
            )}
          >
            Plan
          </h3>
          {approved && (
            <span className="inline-flex rounded-full bg-[var(--studio-accent-soft)] px-8 py-2 text-[10px] font-medium uppercase tracking-wide text-[var(--studio-accent)]">
              Approved
            </span>
          )}
        </div>
        <p
          className={cn(
            'whitespace-pre-wrap text-[var(--studio-fg)]',
            pending ? 'text-[13px] leading-5' : 'text-[12px] leading-5 text-[var(--studio-muted)]',
          )}
        >
          {plan.content.summary}
        </p>

        <section className={cn(pending ? 'mt-14' : 'mt-10')}>
          <h4 className="mb-6 text-[11px] font-medium uppercase tracking-wide text-[var(--studio-faint)]">
            Pages
          </h4>
          <ul className="space-y-8">
            {plan.content.pages.map((page) => (
              <li key={`${page.name}-${page.description}`}>
                <p className={cn('font-medium text-[var(--studio-fg)]', pending ? 'text-[13px]' : 'text-[12px]')}>
                  {page.name}
                </p>
                <p className="text-[12px] leading-5 text-[var(--studio-muted)]">{page.description}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className={cn(pending ? 'mt-14' : 'mt-10')}>
          <h4 className="mb-6 text-[11px] font-medium uppercase tracking-wide text-[var(--studio-faint)]">
            Key Features
          </h4>
          <ul className="list-disc space-y-4 pl-16 text-[12px] leading-5 text-[var(--studio-muted)]">
            {plan.content.keyFeatures.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        </section>
      </div>

      {pending && (
        <div className="border-t border-[var(--studio-line)] px-14 py-12">
          <button
            type="button"
            onClick={onApprove}
            disabled={approving}
            className="inline-flex h-36 w-full items-center justify-center gap-8 rounded-10 bg-[var(--studio-accent)] px-14 text-[13px] font-medium text-[var(--studio-cta-fg)] hover:bg-[var(--studio-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {approving && <Loader2 className="size-14 animate-spin" />}
            Approve &amp; Build
          </button>
          <p className="mt-8 text-center text-[11px] leading-4 text-[var(--studio-faint)]">
            Or describe what to change in the message box below
          </p>
        </div>
      )}
    </article>
  );
}
