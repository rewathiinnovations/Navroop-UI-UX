'use client';

import { ImagePlus, LayoutTemplate, Plus } from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import { AdminEmpty } from '@/components/admin/AdminTable';
import StatusBanner from '@/components/admin/StatusBanner';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import StudioSelect from '@/components/app/studio/StudioSelect';
import StudioTextarea from '@/components/app/studio/StudioTextarea';
import { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABELS } from '@/lib/templates/categories';
import type { PublicTemplate } from '@/lib/templates/types';
import { STACK_IDS, getStack } from '@/lib/stacks';
import { DESIGN_DIRECTION_IDS } from '@/lib/design/directions';

function readError(payload: Record<string, unknown>, fallback: string) {
  const error = payload.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as { message: string }).message);
  return fallback;
}

export default function TemplatesAdmin({
  initialTemplates,
}: {
  initialTemplates: PublicTemplate[];
}) {
  const router = useRouter();
  const [templates, setTemplates] = useState(initialTemplates);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = (next: PublicTemplate) => {
    setTemplates((current) => {
      const index = current.findIndex((row) => row.id === next.id);
      if (index === -1) return [next, ...current];
      const copy = current.slice();
      copy[index] = next;
      return copy;
    });
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    setError('');
    try {
      const response = await fetch(`/api/admin/templates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(readError(payload, 'Could not update template'));
        return;
      }
      refresh(payload.template);
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy('create');
    setError('');
    try {
      const response = await fetch('/api/admin/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.get('name'),
          description: form.get('description'),
          category: form.get('category'),
          stack: form.get('stack'),
          designDirection: form.get('designDirection'),
          prompt: form.get('prompt'),
          slug: form.get('slug') || undefined,
          isBuiltIn: form.get('isBuiltIn') === 'on',
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(readError(payload, 'Could not create template'));
        return;
      }
      refresh(payload.template);
      event.currentTarget.reset();
    } finally {
      setBusy(null);
    }
  };

  const onTest = async (id: string) => {
    setBusy(`test-${id}`);
    setError('');
    try {
      const response = await fetch(`/api/admin/templates/${id}/test`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) {
        setError(readError(payload, 'Could not test this template'));
        return;
      }
      const projectId = payload.id || payload.project?.id;
      if (projectId) router.push(`/project/${projectId}`);
    } finally {
      setBusy(null);
    }
  };

  const onThumbnails = async () => {
    setBusy('thumbs');
    setError('');
    try {
      const response = await fetch('/api/admin/templates/thumbnails', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) {
        setError(readError(payload, 'Could not generate thumbnails'));
        return;
      }
      const failed = (payload.results || []).filter((row: { ok: boolean }) => !row.ok);
      if (payload.message) setError(payload.message);
      else if (failed.length) {
        setError(
          failed
            .map((row: { slug: string; error?: string }) => `${row.slug}: ${row.error}`)
            .join(' '),
        );
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const onUpload = async (id: string, file: File | undefined) => {
    if (!file) return;
    setBusy(`up-${id}`);
    setError('');
    try {
      const form = new FormData();
      form.set('file', file);
      const response = await fetch(`/api/admin/templates/${id}/thumbnail`, {
        method: 'POST',
        body: form,
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(readError(payload, 'Could not upload thumbnail'));
        return;
      }
      refresh(payload.template);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminPage
      icon="templates"
      title="Templates"
      description="Built-in and workspace templates. Reorder, toggle, and test prompts."
      actions={
        <StudioButton
          type="button"
          variant="ghost"
          disabled={busy === 'thumbs'}
          onClick={() => void onThumbnails()}
        >
          {busy === 'thumbs' ? 'Generating…' : 'Generate thumbnails'}
        </StudioButton>
      }
    >
      {error && <StatusBanner tone="error">{error}</StatusBanner>}

      <AdminCard icon={<Plus className="size-14" aria-hidden />} title="New template">
        <form onSubmit={(event) => void onCreate(event)} className="grid gap-12">
          <StudioField id="template-name" name="name" label="Name" required />
          <StudioField
            id="template-description"
            name="description"
            label="One-line description"
            required
          />
          <StudioField id="template-slug" name="slug" label="Slug (optional)" />
          <div className="grid gap-12 sm:grid-cols-3">
            <StudioSelect id="template-category" name="category" label="Category">
              {TEMPLATE_CATEGORIES.map((id) => (
                <option key={id} value={id}>
                  {TEMPLATE_CATEGORY_LABELS[id]}
                </option>
              ))}
            </StudioSelect>
            <StudioSelect id="template-stack" name="stack" label="Stack" defaultValue="NEXTJS">
              {STACK_IDS.map((id) => (
                <option key={id} value={id}>
                  {getStack(id).label}
                </option>
              ))}
            </StudioSelect>
            <StudioSelect
              id="template-design-direction"
              name="designDirection"
              label="Design direction"
              defaultValue="minimal"
            >
              {DESIGN_DIRECTION_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </StudioSelect>
          </div>
          <label className="inline-flex w-fit items-center gap-8 text-[13px] text-[var(--studio-muted)]">
            <input type="checkbox" name="isBuiltIn" /> Built-in (shared across every workspace)
          </label>
          <StudioTextarea id="template-prompt" name="prompt" label="Prompt" required rows={6} />
          <div>
            <StudioButton type="submit" disabled={busy === 'create'}>
              {busy === 'create' ? 'Saving…' : 'Create template'}
            </StudioButton>
          </div>
        </form>
      </AdminCard>

      <AdminCard icon={<LayoutTemplate className="size-14" aria-hidden />} title="All templates">
        {templates.length === 0 ? (
          <AdminEmpty>No templates yet. Create one above.</AdminEmpty>
        ) : (
          <ul className="space-y-12">
            {templates.map((template) => (
              <li key={template.id} className="rounded-12 border border-[var(--studio-line)] p-16">
                <div className="flex flex-wrap items-start justify-between gap-12">
                  <div className="min-w-0">
                    <div className="flex items-center gap-8">
                      <p className="text-[15px] font-medium text-[var(--studio-fg)]">
                        {template.name}
                      </p>
                      <span className="inline-flex items-center gap-6 rounded-full border border-[var(--studio-line)] px-8 py-2 text-[11px] text-[var(--studio-muted)]">
                        <span
                          className={`size-6 shrink-0 rounded-full ${template.isActive ? 'bg-[var(--studio-accent)]' : 'bg-[var(--studio-faint)]'}`}
                          aria-hidden
                        />
                        {template.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <p className="mt-4 text-[12px] text-[var(--studio-faint)]">
                      {template.slug} · {template.category} · {template.stack} · used{' '}
                      {template.usageCount}
                      {template.workspaceId ? ' · workspace' : ' · shared'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-8">
                    <StudioButton
                      type="button"
                      variant={template.isActive ? 'danger' : 'ghost'}
                      disabled={busy === template.id}
                      onClick={() => void patch(template.id, { isActive: !template.isActive })}
                    >
                      {template.isActive ? 'Deactivate' : 'Activate'}
                    </StudioButton>
                    <StudioButton
                      type="button"
                      variant="ghost"
                      disabled={busy === template.id}
                      onClick={() =>
                        void patch(template.id, { sortOrder: Math.max(0, template.sortOrder - 10) })
                      }
                    >
                      Move up
                    </StudioButton>
                    <StudioButton
                      type="button"
                      variant="ghost"
                      disabled={busy === `test-${template.id}`}
                      onClick={() => void onTest(template.id)}
                    >
                      {busy === `test-${template.id}` ? 'Testing…' : 'Test'}
                    </StudioButton>
                    <label className="inline-flex h-44 cursor-pointer items-center gap-6 rounded-full border border-[var(--studio-line-strong)] px-18 text-[14px] font-medium text-[var(--studio-fg)] transition-colors duration-200 hover:bg-[var(--studio-surface)]">
                      <ImagePlus className="size-14" aria-hidden />
                      Upload thumbnail
                      <input
                        type="file"
                        accept="image/png,image/jpeg"
                        className="sr-only"
                        onChange={(event) => void onUpload(template.id, event.target.files?.[0])}
                      />
                    </label>
                  </div>
                </div>
                <StudioTextarea
                  id={`template-prompt-${template.id}`}
                  label="Prompt"
                  defaultValue={template.prompt}
                  rows={5}
                  className="mt-12"
                  onBlur={(event) => {
                    if (event.target.value !== template.prompt) {
                      void patch(template.id, { prompt: event.target.value });
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </AdminCard>
    </AdminPage>
  );
}
