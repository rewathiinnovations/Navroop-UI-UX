'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PENDING_PROMPT_KEY, readDraftStorage, writeDraftStorage } from '@/hooks/useDraftStorage';
import { isDesignDirectionId } from '@/lib/design/directions';
import { DEFAULT_IMPORT_MODE } from '@/lib/import/mode';
import { isStackId } from '@/lib/stacks';
import { TEMPLATE_CATEGORY_LABELS, isTemplateCategory } from '@/lib/templates/categories';
import type { PublicTemplate } from '@/lib/templates/types';
import { notify, toMessage } from '@/lib/notify';

export default function TemplateSheet({
  template,
  onClose,
}: {
  template: PublicTemplate | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!template) return;
    const stored = readDraftStorage(PENDING_PROMPT_KEY);
    setPrompt(stored?.templateId === template.id && stored.text ? stored.text : template.prompt);
  }, [template]);

  useEffect(() => {
    if (!template) return;
    const stack = isStackId(template.stack) ? template.stack : 'NEXTJS';
    const direction = isDesignDirectionId(template.designDirection)
      ? template.designDirection
      : 'minimal';
    const timer = window.setTimeout(() => {
      writeDraftStorage(PENDING_PROMPT_KEY, prompt, stack, direction, DEFAULT_IMPORT_MODE, template.id);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [prompt, template]);

  if (!template) return null;

  const category = isTemplateCategory(template.category)
    ? TEMPLATE_CATEGORY_LABELS[template.category]
    : template.category;

  // Creating the project takes a while and ends in a navigation, so the
  // feedback is a pending toast settled in place rather than a line in a sheet
  // that is about to disappear.
  const create = async () => {
    setBusy(true);
    const toastId = notify.loading('Creating your project…');
    try {
      const response = await fetch(`/api/templates/${template.id}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          payload.error?.message || payload.error || payload.message || 'Could not create from this template';
        notify.settle(toastId, 'error', String(message));
        return;
      }
      const id = payload.id || payload.project?.id;
      if (!id) {
        notify.settle(toastId, 'error', 'Could not create from this template');
        return;
      }
      notify.settle(toastId, 'success', 'Project created — opening it now.');
      router.push(`/project/${id}`);
    } catch (cause) {
      notify.settle(toastId, 'error', toMessage(cause, 'Could not create from this template'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" role="dialog" aria-modal="true" aria-labelledby="template-sheet-title">
      <button type="button" className="h-full flex-1 cursor-default" aria-label="Close" onClick={onClose} />
      <aside className="flex h-full w-full max-w-[480px] flex-col border-l border-[var(--studio-line)] bg-[var(--studio-bg)] shadow-sm">
        <div className="flex items-start justify-between gap-12 border-b border-[var(--studio-line)] px-20 py-16">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--studio-faint)]">{category}</p>
            <h2 id="template-sheet-title" className="mt-4 text-[22px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
              {template.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[36px] items-center rounded-10 px-10 text-[13px] text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)]"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-16 overflow-y-auto px-20 py-16">
          <div className="overflow-hidden rounded-12 bg-[var(--studio-skeleton)]">
            {template.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={template.thumbnailUrl} alt="" className="h-200 w-full object-cover" />
            ) : (
              <div className="flex h-160 items-center justify-center text-[13px] text-[var(--studio-faint)]">
                No thumbnail yet
              </div>
            )}
          </div>
          <p className="text-[14px] leading-6 text-[var(--studio-muted)]">{template.description}</p>
          {template.previewUrl ? (
            <a
              href={template.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-[13px] font-medium text-[var(--studio-accent)] hover:underline"
            >
              View demo
            </a>
          ) : null}
          <label className="block">
            <span className="mb-6 block text-[12px] font-medium text-[var(--studio-fg)]">Prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={14}
              className="w-full rounded-12 border border-[var(--studio-line-strong)] bg-[var(--studio-surface)] px-12 py-10 text-[13px] leading-5 text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
            />
          </label>
        </div>
        <div className="border-t border-[var(--studio-line)] px-20 py-14">
          <button
            type="button"
            disabled={busy || !prompt.trim()}
            onClick={() => void create()}
            className="inline-flex h-40 w-full items-center justify-center rounded-10 bg-[var(--studio-fg)] text-[13px] font-medium text-[var(--studio-bg)] disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create from this template'}
          </button>
        </div>
      </aside>
    </div>
  );
}
