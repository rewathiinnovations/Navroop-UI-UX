'use client';

import { FormEvent, useEffect, useState } from 'react';
import { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABELS } from '@/lib/templates/categories';
import { notify, toMessage } from '@/lib/notify';

export default function SaveAsTemplateDialog({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<(typeof TEMPLATE_CATEGORIES)[number]>('business');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!open || !projectId) return;
    setError('');
    setDone('');
    void fetch(`/api/templates/from-project?projectId=${encodeURIComponent(projectId)}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setError(payload.error?.message || payload.error || 'Could not prepare this template');
          return;
        }
        setName(payload.name || '');
        setDescription(payload.description || '');
        setPrompt(payload.prompt || '');
      })
      .catch(() => setError('Could not prepare this template'));
  }, [open, projectId]);

  if (!open) return null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/templates/from-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, name, description, category, prompt }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error?.message || payload.error || 'Could not save as template');
        return;
      }
      const message = payload.thumbnailWarning || 'Saved as a workspace template.';
      setDone(message);
      // Also toasted so the confirmation survives closing the dialog.
      notify.success(message, { key: 'save-as-template' });
    } catch (cause) {
      setError(toMessage(cause, 'Could not save as template'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-16"
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-template-title"
    >
      <form
        onSubmit={(event) => void onSubmit(event)}
        className="w-full max-w-[560px] rounded-16 border border-[var(--studio-line)] bg-[var(--studio-bg)] p-20 shadow-sm"
      >
        <h2
          id="save-template-title"
          className="text-[20px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]"
        >
          Save as template
        </h2>
        <p className="mt-6 text-[13px] text-[var(--studio-muted)]">
          Private to this workspace. Edit the prompt before you save.
        </p>
        <div className="mt-16 space-y-12">
          <label className="block text-[12px] font-medium text-[var(--studio-fg)]">
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              className="mt-6 h-40 w-full rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-surface)] px-12 text-[13px]"
            />
          </label>
          <label className="block text-[12px] font-medium text-[var(--studio-fg)]">
            Description
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              required
              className="mt-6 h-40 w-full rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-surface)] px-12 text-[13px]"
            />
          </label>
          <label className="block text-[12px] font-medium text-[var(--studio-fg)]">
            Category
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as typeof category)}
              className="mt-6 h-40 w-full rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-surface)] px-12 text-[13px]"
            >
              {TEMPLATE_CATEGORIES.map((id) => (
                <option key={id} value={id}>
                  {TEMPLATE_CATEGORY_LABELS[id]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[12px] font-medium text-[var(--studio-fg)]">
            Prompt
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              required
              rows={10}
              className="mt-6 w-full rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-surface)] px-12 py-10 text-[13px] leading-5"
            />
          </label>
        </div>
        {error ? (
          <p className="mt-12 text-[13px] text-[var(--studio-danger)]" role="alert">
            {error}
          </p>
        ) : null}
        {done ? (
          <p className="mt-12 text-[13px] text-[var(--studio-muted)]" role="status">
            {done}
          </p>
        ) : null}
        <div className="mt-16 flex justify-end gap-8">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-36 items-center rounded-10 px-12 text-[13px] text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)]"
          >
            Close
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex h-36 items-center rounded-10 bg-[var(--studio-fg)] px-14 text-[13px] font-medium text-[var(--studio-bg)] disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save as template'}
          </button>
        </div>
      </form>
    </div>
  );
}
