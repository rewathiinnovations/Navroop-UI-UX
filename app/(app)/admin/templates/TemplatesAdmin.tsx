'use client';

import { FileText, ImagePlus, LayoutTemplate, Plus } from 'lucide-react';
import Accordion from '@/components/admin/Accordion';
import StatusPill from '@/components/admin/StatusPill';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import { AdminEmpty } from '@/components/admin/AdminTable';
import { FormEvent, useState } from 'react';
import { useUnsavedChangesWarning } from '@/hooks/useUnsavedChangesWarning';
import { notify, toMessage } from '@/lib/notify';
import { useRouter } from 'next/navigation';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import StudioSelect from '@/components/app/studio/StudioSelect';
import StudioTextarea from '@/components/app/studio/StudioTextarea';
import { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABELS } from '@/lib/templates/categories';
import type { PublicTemplate } from '@/lib/templates/types';
import { STACK_IDS, getStack } from '@/lib/stacks';
import { DESIGN_DIRECTIONS, DESIGN_DIRECTION_IDS } from '@/lib/design/directions';

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
  const [busy, setBusy] = useState<string | null>(null);
  // A template prompt is often paragraphs of hand-written text; losing it to a
  // stray tab close hurts. The form is uncontrolled, so dirtiness is tracked
  // from the first input event and cleared when the create succeeds.
  const [draftingTemplate, setDraftingTemplate] = useState(false);
  useUnsavedChangesWarning(draftingTemplate);

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
    try {
      const response = await fetch(`/api/admin/templates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        notify.error(readError(payload, 'Could not update template'), { key: `template-${id}` });
        return;
      }
      refresh(payload.template);
      notify.success(`“${payload.template.name}” updated.`, { key: `template-${id}` });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not update template', key: `template-${id}` });
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy('create');
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
        notify.error(readError(payload, 'Could not create template'), { key: 'template-create' });
        return;
      }
      refresh(payload.template);
      formElement.reset();
      setDraftingTemplate(false);
      notify.success(`Template “${payload.template.name}” created.`, {
        key: 'template-create',
      });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not create template', key: 'template-create' });
    } finally {
      setBusy(null);
    }
  };

  const onTest = async (id: string) => {
    setBusy(`test-${id}`);
    const toastId = notify.loading('Creating a test project from this template…');
    try {
      const response = await fetch(`/api/admin/templates/${id}/test`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) {
        notify.settle(toastId, 'error', readError(payload, 'Could not test this template'));
        return;
      }
      const projectId = payload.id || payload.project?.id;
      if (projectId) {
        notify.settle(toastId, 'success', 'Test project created — opening it now.');
        router.push(`/project/${projectId}`);
      } else {
        notify.settle(toastId, 'warning', 'The template ran but no project came back.');
      }
    } catch (cause) {
      notify.settle(toastId, 'error', toMessage(cause, 'Could not test this template'));
    } finally {
      setBusy(null);
    }
  };

  const onThumbnails = async () => {
    setBusy('thumbs');
    const toastId = notify.loading('Generating thumbnails…');
    try {
      const response = await fetch('/api/admin/templates/thumbnails', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) {
        notify.settle(toastId, 'error', readError(payload, 'Could not generate thumbnails'));
        return;
      }
      const results = (payload.results || []) as Array<{
        ok: boolean;
        slug: string;
        error?: string;
      }>;
      const failed = results.filter((row) => !row.ok);
      const remaining = typeof payload.remaining === 'number' ? payload.remaining : 0;
      // F-823: the batch is bounded, so `payload.message` now carries the
      // how-much-is-left note on *every* press, not just the "nothing to do"
      // one. A failure has to outrank it — testing `message` first would have
      // reported a failed capture as an info toast.
      if (failed.length) {
        notify.settle(
          toastId,
          'warning',
          `${failed.length} of ${results.length} failed — ${failed
            .map((row) => `${row.slug}: ${row.error}`)
            .join(', ')}`,
          { autoClose: 10000 },
        );
      } else if (payload.message) {
        // Unfinished work is not success: the operator has to press again.
        notify.settle(toastId, remaining > 0 ? 'info' : 'success', payload.message);
      } else {
        notify.settle(toastId, 'success', `Generated ${results.length} thumbnails.`);
      }
      router.refresh();
    } catch (cause) {
      notify.settle(toastId, 'error', toMessage(cause, 'Could not generate thumbnails'));
    } finally {
      setBusy(null);
    }
  };

  const onUpload = async (id: string, file: File | undefined) => {
    if (!file) return;
    setBusy(`up-${id}`);
    try {
      const form = new FormData();
      form.set('file', file);
      const response = await fetch(`/api/admin/templates/${id}/thumbnail`, {
        method: 'POST',
        body: form,
      });
      const payload = await response.json();
      if (!response.ok) {
        notify.error(readError(payload, 'Could not upload thumbnail'), { key: `thumb-${id}` });
        return;
      }
      refresh(payload.template);
      notify.success('Thumbnail uploaded.', { key: `thumb-${id}` });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not upload thumbnail', key: `thumb-${id}` });
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
      <Accordion
        icon={<Plus className="size-14" aria-hidden />}
        title="New template"
        description="Add a starting point members can pick when creating a project."
      >
        <form
          onSubmit={(event) => void onCreate(event)}
          onInput={() => setDraftingTemplate(true)}
          className="grid gap-12"
        >
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
                  {DESIGN_DIRECTIONS[id].label}
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
      </Accordion>

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
                      <StatusPill tone={template.isActive ? 'positive' : 'neutral'}>
                        {template.isActive ? 'Active' : 'Inactive'}
                      </StatusPill>
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
                <div className="mt-12">
                  <Accordion
                    icon={<FileText className="size-13" aria-hidden />}
                    title="Edit prompt"
                  >
                    <StudioTextarea
                      id={`template-prompt-${template.id}`}
                      label="Prompt"
                      defaultValue={template.prompt}
                      rows={8}
                      onBlur={(event) => {
                        if (event.target.value !== template.prompt) {
                          void patch(template.id, { prompt: event.target.value });
                        }
                      }}
                    />
                  </Accordion>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AdminCard>
    </AdminPage>
  );
}
