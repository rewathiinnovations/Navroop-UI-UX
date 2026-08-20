import Link from 'next/link';

/**
 * A project id that does not resolve (F-445).
 *
 * `page.tsx` used to tolerate a missing row and render the workspace anyway — an empty chat,
 * an empty preview and no explanation, which reads as a broken product rather than a bad
 * link. It calls `notFound()` now, and this is what that renders: inside the workspace
 * layout, with the only two routes that make sense from here.
 */
export default function ProjectNotFound() {
  return (
    <main className="mx-auto flex h-full max-w-[520px] flex-col justify-center px-20 py-40">
      <h1 className="mb-12 text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
        Project not found
      </h1>
      <p className="text-[14px] text-[var(--studio-muted)]">
        This project does not exist, or it was deleted.
      </p>
      <div className="mt-20 flex flex-wrap items-center gap-14">
        <Link
          href="/dashboard"
          className="inline-flex h-36 items-center rounded-full bg-[var(--studio-fg)] px-14 text-[13px] text-[var(--studio-bg)]"
        >
          Back to dashboard
        </Link>
        <Link href="/projects" className="text-[13px] text-[var(--studio-accent)] hover:underline">
          All projects
        </Link>
      </div>
    </main>
  );
}
