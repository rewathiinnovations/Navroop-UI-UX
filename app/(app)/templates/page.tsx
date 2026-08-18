import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import StudioShell from '@/components/app/studio/StudioShell';
import TemplateGallery from '@/components/templates/TemplateGallery';
import { getSessionUser } from '@/lib/auth';
import { listTemplates } from '@/lib/templates/actions';

export default async function TemplatesPage() {
  const user = await getSessionUser();
  if (!user) redirect('/dashboard');

  const result = await listTemplates({ sort: 'popular' });
  const templates = result && result.ok ? result.data.templates : [];

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[960px] px-20 pb-64 pt-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">Templates</h1>
        <p className="mt-8 max-w-[560px] text-[15px] leading-6 text-[var(--studio-muted)]">
          Start from a detailed brief. Edit the prompt before you create — plan mode still runs.
        </p>
        <div className="mt-28">
          <Suspense fallback={<p className="text-[14px] text-[var(--studio-muted)]">Loading templates…</p>}>
            <TemplateGallery initialTemplates={templates} />
          </Suspense>
        </div>
      </main>
    </StudioShell>
  );
}
