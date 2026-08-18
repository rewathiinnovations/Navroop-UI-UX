import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import DomainsPanel from '@/components/workspace/DomainsPanel';
import Link from 'next/link';

export default async function ProjectDomainsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!project) redirect('/dashboard');

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--studio-bg)]">
      <header className="flex items-center gap-12 border-b border-[var(--studio-line)] px-16 py-12">
        <Link href={`/project/${id}`} className="text-[13px] text-[var(--studio-muted)] hover:text-[var(--studio-fg)]">
          Back to workspace
        </Link>
        <h1 className="text-[14px] font-semibold text-[var(--studio-fg)]">{project.name} — Domains</h1>
      </header>
      <div className="min-h-0 flex-1">
        <DomainsPanel projectId={id} />
      </div>
    </div>
  );
}
