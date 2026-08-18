'use client';

import { TEMPLATE_CATEGORY_LABELS, isTemplateCategory } from '@/lib/templates/categories';
import type { PublicTemplate } from '@/lib/templates/types';

export default function TemplateCard({
  template,
  onOpen,
}: {
  template: PublicTemplate;
  onOpen: (template: PublicTemplate) => void;
}) {
  const category = isTemplateCategory(template.category)
    ? TEMPLATE_CATEGORY_LABELS[template.category]
    : template.category;

  return (
    <button
      type="button"
      onClick={() => onOpen(template)}
      className="flex flex-col overflow-hidden rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] text-left transition-colors duration-200 hover:border-[var(--studio-line-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
    >
      <div className="relative h-140 bg-[var(--studio-skeleton)]">
        {template.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={template.thumbnailUrl} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-[12px] text-[var(--studio-faint)]">
            {category}
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-6 px-14 py-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--studio-faint)]">{category}</p>
        <h3 className="text-[15px] font-medium text-[var(--studio-fg)]">{template.name}</h3>
        <p className="line-clamp-2 text-[13px] leading-5 text-[var(--studio-muted)]">{template.description}</p>
      </div>
    </button>
  );
}
