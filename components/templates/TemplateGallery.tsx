'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { STACK_IDS, getStack } from '@/lib/stacks';
import { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABELS } from '@/lib/templates/categories';
import type { PublicTemplate, TemplateSort } from '@/lib/templates/types';
import TemplateCard from './TemplateCard';
import TemplateSheet from './TemplateSheet';

export default function TemplateGallery({
  initialTemplates,
  initialError = '',
}: {
  initialTemplates: PublicTemplate[];
  /**
   * F-429: why the server load failed, when it did. Folding that into an empty
   * array made a broken list indistinguishable from a filter that matched
   * nothing, and the gallery said "No templates match these filters."
   */
  initialError?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const category = searchParams.get('category') || '';
  const stack = searchParams.get('stack') || '';
  const sort = (searchParams.get('sort') === 'newest' ? 'newest' : 'popular') as TemplateSort;
  const [templates, setTemplates] = useState(initialTemplates);
  const [open, setOpen] = useState<PublicTemplate | null>(null);
  const [error, setError] = useState(initialError);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const query = next.toString();
    router.replace(query ? `/templates?${query}` : '/templates');
  };

  useEffect(() => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (stack) params.set('stack', stack);
    if (sort) params.set('sort', sort);
    const query = params.toString();
    void fetch(`/api/templates${query ? `?${query}` : ''}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setError(payload.error?.message || payload.error || 'Could not load templates');
          return;
        }
        setTemplates(payload.templates || []);
        setError('');
      })
      .catch(() => setError('Could not load templates'));
  }, [category, sort, stack]);

  const openId = searchParams.get('open');
  const selected = useMemo(
    () => open || templates.find((row) => row.id === openId || row.slug === openId) || null,
    [open, openId, templates],
  );

  return (
    <div>
      <div className="mb-20 flex flex-wrap items-center gap-8">
        <label className="inline-flex items-center gap-8 text-[13px] text-[var(--studio-muted)]">
          Category
          <select
            value={category}
            aria-label="Category"
            onChange={(event) => setParam('category', event.target.value)}
            className="h-36 rounded-10 border border-[var(--studio-line-strong)] bg-transparent px-10 text-[13px] text-[var(--studio-fg)]"
          >
            <option value="">All categories</option>
            {TEMPLATE_CATEGORIES.map((id) => (
              <option key={id} value={id}>
                {TEMPLATE_CATEGORY_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-8 text-[13px] text-[var(--studio-muted)]">
          Stack
          <select
            value={stack}
            aria-label="Stack"
            onChange={(event) => setParam('stack', event.target.value)}
            className="h-36 rounded-10 border border-[var(--studio-line-strong)] bg-transparent px-10 text-[13px] text-[var(--studio-fg)]"
          >
            <option value="">All stacks</option>
            {STACK_IDS.map((id) => (
              <option key={id} value={id}>
                {getStack(id).label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-8 text-[13px] text-[var(--studio-muted)]">
          Sort
          <select
            value={sort}
            aria-label="Sort"
            onChange={(event) => setParam('sort', event.target.value)}
            className="h-36 rounded-10 border border-[var(--studio-line-strong)] bg-transparent px-10 text-[13px] text-[var(--studio-fg)]"
          >
            <option value="popular">Popular</option>
            <option value="newest">Newest</option>
          </select>
        </label>
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-12 border border-[var(--studio-danger)] px-20 py-40 text-center text-[14px] text-[var(--studio-danger)]"
        >
          {error} Reload the page to try again.
        </p>
      ) : templates.length === 0 ? (
        <p className="rounded-12 border border-[var(--studio-line)] px-20 py-40 text-center text-[14px] text-[var(--studio-muted)]">
          No templates match these filters.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <TemplateCard key={template.id} template={template} onOpen={setOpen} />
          ))}
        </div>
      )}
      <TemplateSheet
        template={selected}
        onClose={() => {
          setOpen(null);
          // The sheet also resolves from `?open=<slug>`, the shareable link the
          // gallery supports. Clearing only the click-driven half left the URL to
          // re-derive `selected` on the next render, so Close reopened the sheet
          // and there was no way out but editing the address bar.
          if (openId) setParam('open', '');
        }}
        onDeleted={(id) => {
          setTemplates((current) => current.filter((row) => row.id !== id));
          setOpen(null);
          if (openId) setParam('open', '');
        }}
      />
    </div>
  );
}
