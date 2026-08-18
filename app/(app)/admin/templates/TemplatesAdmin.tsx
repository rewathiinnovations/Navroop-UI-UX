'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import StudioShell from '@/components/app/studio/StudioShell';
import PageTabs from '@/components/app/studio/PageTabs';
import { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABELS } from '@/lib/templates/categories';
import type { PublicTemplate } from '@/lib/templates/types';
import { STACK_IDS, getStack } from '@/lib/stacks';
import { DESIGN_DIRECTION_IDS } from '@/lib/design/directions';

const adminTabs = (active: string) => [
  { href: '/admin/team', label: 'Team', active: active === 'team' },
  { href: '/admin/usage', label: 'Usage', active: active === 'usage' },
  { href: '/admin/quality', label: 'Quality', active: active === 'quality' },
  { href: '/admin/health', label: 'Health', active: active === 'health' },
  { href: '/admin/jobs', label: 'Jobs', active: active === 'jobs' },
  { href: '/admin/backups', label: 'Backups', active: active === 'backups' },
  { href: '/admin/audit', label: 'Audit', active: active === 'audit' },
  { href: '/admin/integrations', label: 'Integrations', active: active === 'integrations' },
  { href: '/admin/deploy', label: 'Deploy', active: active === 'deploy' },
  { href: '/admin/servers', label: 'Servers', active: active === 'servers' },
  { href: '/admin/plans', label: 'Plans', active: active === 'plans' },
  { href: '/admin/workspace', label: 'Workspace', active: active === 'workspace' },
  { href: '/admin/templates', label: 'Templates', active: active === 'templates' },
  { href: '/admin/sandbox-providers', label: 'Sandbox providers', active: active === 'sandbox-providers' },
];

function readError(payload: Record<string, unknown>, fallback: string) {
  const error = payload.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: string }).message);
  return fallback;
}

export default function TemplatesAdmin({ initialTemplates }: { initialTemplates: PublicTemplate[] }) {
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
        setError(failed.map((row: { slug: string; error?: string }) => `${row.slug}: ${row.error}`).join(' '));
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
      const response = await fetch(`/api/admin/templates/${id}/thumbnail`, { method: 'POST', body: form });
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
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[960px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">Admin</h1>
        <PageTabs items={adminTabs('templates')} />
        <div className="mb-20 flex flex-wrap items-center justify-between gap-12">
          <p className="text-[14px] text-[var(--studio-muted)]">
            Built-in and workspace templates. Reorder, toggle, and test prompts.
          </p>
          <button
            type="button"
            disabled={busy === 'thumbs'}
            onClick={() => void onThumbnails()}
            className="inline-flex h-36 items-center rounded-10 border border-[var(--studio-line-strong)] px-12 text-[13px] text-[var(--studio-fg)] disabled:opacity-50"
          >
            {busy === 'thumbs' ? 'Generating…' : 'Generate thumbnails'}
          </button>
        </div>
        {error ? (
          <p className="mb-16 text-[13px] text-[var(--studio-danger)]" role="alert">
            {error}
          </p>
        ) : null}

        <form onSubmit={(event) => void onCreate(event)} className="mb-28 grid gap-10 rounded-12 border border-[var(--studio-line)] p-16">
          <p className="text-[14px] font-medium text-[var(--studio-fg)]">New template</p>
          <input name="name" required placeholder="Name" className="h-36 rounded-10 border border-[var(--studio-line-strong)] px-10 text-[13px]" />
          <input name="description" required placeholder="One-line description" className="h-36 rounded-10 border border-[var(--studio-line-strong)] px-10 text-[13px]" />
          <input name="slug" placeholder="slug (optional)" className="h-36 rounded-10 border border-[var(--studio-line-strong)] px-10 text-[13px]" />
          <div className="flex flex-wrap gap-8">
            <select name="category" className="h-36 rounded-10 border border-[var(--studio-line-strong)] px-10 text-[13px]">
              {TEMPLATE_CATEGORIES.map((id) => (
                <option key={id} value={id}>
                  {TEMPLATE_CATEGORY_LABELS[id]}
                </option>
              ))}
            </select>
            <select name="stack" defaultValue="NEXTJS" className="h-36 rounded-10 border border-[var(--studio-line-strong)] px-10 text-[13px]">
              {STACK_IDS.map((id) => (
                <option key={id} value={id}>
                  {getStack(id).label}
                </option>
              ))}
            </select>
            <select name="designDirection" defaultValue="minimal" className="h-36 rounded-10 border border-[var(--studio-line-strong)] px-10 text-[13px]">
              {DESIGN_DIRECTION_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-6 text-[13px] text-[var(--studio-muted)]">
              <input type="checkbox" name="isBuiltIn" /> Built-in
            </label>
          </div>
          <textarea name="prompt" required rows={6} placeholder="Prompt" className="rounded-10 border border-[var(--studio-line-strong)] px-10 py-8 text-[13px]" />
          <button
            type="submit"
            disabled={busy === 'create'}
            className="inline-flex h-36 w-fit items-center rounded-10 bg-[var(--studio-fg)] px-14 text-[13px] font-medium text-[var(--studio-bg)] disabled:opacity-50"
          >
            {busy === 'create' ? 'Saving…' : 'Create template'}
          </button>
        </form>

        <ul className="space-y-12">
          {templates.map((template) => (
            <li key={template.id} className="rounded-12 border border-[var(--studio-line)] p-16">
              <div className="flex flex-wrap items-start justify-between gap-12">
                <div>
                  <p className="text-[15px] font-medium text-[var(--studio-fg)]">{template.name}</p>
                  <p className="mt-4 text-[12px] text-[var(--studio-faint)]">
                    {template.slug} · {template.category} · {template.stack} · used {template.usageCount}
                    {template.workspaceId ? ' · workspace' : ' · shared'}
                    {template.isActive ? '' : ' · inactive'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-6">
                  <button
                    type="button"
                    disabled={busy === template.id}
                    onClick={() => void patch(template.id, { isActive: !template.isActive })}
                    className="inline-flex h-32 items-center rounded-8 border border-[var(--studio-line-strong)] px-10 text-[12px]"
                  >
                    {template.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    type="button"
                    disabled={busy === template.id}
                    onClick={() => void patch(template.id, { sortOrder: Math.max(0, template.sortOrder - 10) })}
                    className="inline-flex h-32 items-center rounded-8 border border-[var(--studio-line-strong)] px-10 text-[12px]"
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    disabled={busy === `test-${template.id}`}
                    onClick={() => void onTest(template.id)}
                    className="inline-flex h-32 items-center rounded-8 border border-[var(--studio-line-strong)] px-10 text-[12px]"
                  >
                    Test
                  </button>
                  <label className="inline-flex h-32 cursor-pointer items-center rounded-8 border border-[var(--studio-line-strong)] px-10 text-[12px]">
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
              <textarea
                defaultValue={template.prompt}
                rows={5}
                className="mt-12 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8 text-[12px] leading-5"
                onBlur={(event) => {
                  if (event.target.value !== template.prompt) {
                    void patch(template.id, { prompt: event.target.value });
                  }
                }}
              />
            </li>
          ))}
        </ul>
      </main>
    </StudioShell>
  );
}
