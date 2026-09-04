'use client';

import { useState } from 'react';
import { Loader2, Pencil, X, Check } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { WorkspacePlan } from './types';

type EditableContent = WorkspacePlan['content'];

function EditablePlan({
  plan,
  saving,
  onSave,
  onCancel,
}: {
  plan: WorkspacePlan;
  saving: boolean;
  onSave: (content: EditableContent) => void;
  onCancel: () => void;
}) {
  const [summary, setSummary] = useState(plan.content.summary);
  const [pages, setPages] = useState(plan.content.pages.map((page) => ({ ...page })));
  const [keyFeatures, setKeyFeatures] = useState([...plan.content.keyFeatures]);

  const updatePage = (i: number, patch: Partial<EditableContent['pages'][number]>) => {
    setPages((prev) => prev.map((page, idx) => (idx === i ? { ...page, ...patch } : page)));
  };

  const save = () => {
    onSave({
      // `route` rides along untouched: the editor does not offer it as a field,
      // and dropping it here would silently turn an edited multi-page plan back
      // into one the build is free to collapse onto a single page.
      pages: pages.filter((p) => p.name.trim() && p.description.trim()),
      summary,
      keyFeatures: keyFeatures.filter((f) => f.trim()),
    });
  };

  return (
    <div className="space-y-14" data-testid="plan-editor">
      <div>
        <label className="mb-4 block text-[11px] font-medium uppercase tracking-wide text-[var(--studio-faint)]">
          Summary
        </label>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={4}
          className="w-full resize-y rounded-10 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-12 py-10 text-[13px] leading-5 text-[var(--studio-fg)] outline-none focus:border-[var(--studio-accent)]"
        />
      </div>

      <div>
        <label className="mb-4 block text-[11px] font-medium uppercase tracking-wide text-[var(--studio-faint)]">
          Pages
        </label>
        <div className="space-y-8">
          {pages.map((page, i) => (
            <div key={i} className="space-y-4 rounded-10 border border-[var(--studio-line)] p-10">
              <input
                value={page.name}
                onChange={(e) => updatePage(i, { name: e.target.value })}
                placeholder="Page name"
                className="w-full rounded-8 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-10 py-6 text-[13px] font-medium text-[var(--studio-fg)] outline-none focus:border-[var(--studio-accent)]"
              />
              <textarea
                value={page.description}
                onChange={(e) => updatePage(i, { description: e.target.value })}
                placeholder="Page description"
                rows={2}
                className="w-full resize-y rounded-8 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-10 py-6 text-[12px] leading-5 text-[var(--studio-fg)] outline-none focus:border-[var(--studio-accent)]"
              />
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setPages((prev) => [...prev, { name: '', description: '' }])}
          className="mt-8 text-[12px] font-medium text-[var(--studio-accent)] hover:underline"
        >
          + Add page
        </button>
      </div>

      <div>
        <label className="mb-4 block text-[11px] font-medium uppercase tracking-wide text-[var(--studio-faint)]">
          Key Features
        </label>
        <div className="space-y-4">
          {keyFeatures.map((feature, i) => (
            <input
              key={i}
              value={feature}
              onChange={(e) =>
                setKeyFeatures((prev) => prev.map((f, idx) => (idx === i ? e.target.value : f)))
              }
              placeholder="Feature"
              className="w-full rounded-8 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-10 py-6 text-[12px] text-[var(--studio-fg)] outline-none focus:border-[var(--studio-accent)]"
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setKeyFeatures((prev) => [...prev, ''])}
          className="mt-8 text-[12px] font-medium text-[var(--studio-accent)] hover:underline"
        >
          + Add feature
        </button>
      </div>

      <div className="flex items-center gap-8 pt-4">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-32 items-center gap-6 rounded-10 bg-[var(--studio-fg)] px-12 text-[12px] font-medium text-[var(--studio-bg)] disabled:opacity-50"
        >
          {saving && <Loader2 className="size-12 animate-spin" />}
          <Check className="size-12" />
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex h-32 items-center gap-6 rounded-10 border border-[var(--studio-line-strong)] px-12 text-[12px] font-medium text-[var(--studio-fg)] disabled:opacity-50"
        >
          <X className="size-12" />
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function PlanCard({
  plan,
  approving,
  editing,
  saving,
  onApprove,
  onEdit,
  onCancelEdit,
  onUpdate,
}: {
  plan: WorkspacePlan;
  approving?: boolean;
  editing?: boolean;
  saving?: boolean;
  onApprove?: () => void;
  onEdit?: () => void;
  onCancelEdit?: () => void;
  onUpdate?: (content: EditableContent) => void;
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
          <div className="flex items-center gap-8">
            {pending && !editing && onEdit && (
              <button
                type="button"
                onClick={onEdit}
                aria-label="Edit plan"
                className="inline-flex items-center gap-4 rounded-full border border-[var(--studio-line-strong)] px-8 py-2 text-[11px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
              >
                <Pencil className="size-12" />
                Edit
              </button>
            )}
            {approved && (
              <span className="inline-flex rounded-full bg-[var(--studio-accent-soft)] px-8 py-2 text-[10px] font-medium uppercase tracking-wide text-[var(--studio-accent)]">
                Approved
              </span>
            )}
          </div>
        </div>

        {editing && onUpdate ? (
          <EditablePlan
            plan={plan}
            saving={saving ?? false}
            onSave={onUpdate}
            onCancel={onCancelEdit ?? (() => {})}
          />
        ) : (
          <>
            <p
              className={cn(
                'whitespace-pre-wrap text-[var(--studio-fg)]',
                pending
                  ? 'text-[13px] leading-5'
                  : 'text-[12px] leading-5 text-[var(--studio-muted)]',
              )}
            >
              {plan.content.summary}
            </p>

            {plan.content.designVision ? (
              <section className={cn(pending ? 'mt-14' : 'mt-10')}>
                <h4 className="mb-6 text-[11px] font-medium uppercase tracking-wide text-[var(--studio-faint)]">
                  Design vision
                </h4>
                {/* Shown before the pages because it is approved along with them:
                    the build treats it as a contract, so the person approving
                    should see exactly what look they are signing off on. */}
                <p className="whitespace-pre-wrap text-[12px] leading-5 text-[var(--studio-muted)]">
                  {plan.content.designVision}
                </p>
              </section>
            ) : null}

            <section className={cn(pending ? 'mt-14' : 'mt-10')}>
              <h4 className="mb-6 text-[11px] font-medium uppercase tracking-wide text-[var(--studio-faint)]">
                Pages
              </h4>
              <ul className="space-y-8">
                {plan.content.pages.map((page) => (
                  <li key={`${page.name}-${page.description}`}>
                    <p
                      className={cn(
                        'flex flex-wrap items-baseline gap-6 font-medium text-[var(--studio-fg)]',
                        pending ? 'text-[13px]' : 'text-[12px]',
                      )}
                    >
                      {page.name}
                      {/* The route is the contract the build has to satisfy — a
                          nav link to a page nobody wrote is the failure a visitor
                          meets first — so it is shown, not hidden in the JSON.
                          Absent on plans written before routes existed. */}
                      {page.route ? (
                        <code className="rounded-6 bg-[var(--studio-subtle)] px-6 py-1 text-[11px] font-normal text-[var(--studio-muted)]">
                          {page.route}
                        </code>
                      ) : null}
                    </p>
                    <p className="text-[12px] leading-5 text-[var(--studio-muted)]">
                      {page.description}
                    </p>
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
          </>
        )}
      </div>

      {pending && !editing && (
        <div className="border-t border-[var(--studio-line)] px-14 py-12">
          <button
            type="button"
            onClick={onApprove}
            disabled={approving}
            className="inline-flex h-36 w-full items-center justify-center gap-8 rounded-10 [background-image:var(--studio-cta-gradient)] px-14 text-[13px] font-medium text-[var(--studio-cta-fg)] transition-[filter] duration-200 hover:brightness-[1.07] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
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
