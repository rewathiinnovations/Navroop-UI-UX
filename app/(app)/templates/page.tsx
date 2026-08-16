import StudioShell from '@/components/app/studio/StudioShell';

export default function TemplatesPage() {
  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[640px] px-20 py-56">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
          Templates
        </h1>
        <p className="mt-12 text-[15px] text-[var(--studio-muted)]">Coming soon</p>
      </main>
    </StudioShell>
  );
}
