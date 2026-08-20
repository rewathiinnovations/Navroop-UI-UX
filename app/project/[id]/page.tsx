import { auth } from '@/auth';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getGitHubConnectionStatusForUser } from '@/lib/github/connection';
import { getLatestPlan } from '@/lib/projects/plan';
import { toWorkspacePlan } from '@/components/workspace/types';
import GenerationWorkspace from '@/components/workspace/GenerationWorkspace';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The proxy's page gate only checks that a session cookie *exists*
  // (`hasSessionCookie`), so this page runs for a stale or garbage cookie.
  // `auth()` decrypts and validates the token — without a verified session,
  // nothing is fetched and nothing renders (F-013). Same pattern as
  // `app/project/[id]/domains/page.tsx`. Any verified member may view:
  // project reads are workspace-wide by design.
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect('/');

  const [github, project, planResult] = await Promise.all([
    getGitHubConnectionStatusForUser(prisma, userId),
    prisma.project.findFirst({
      where: { id, deletedAt: null },
      select: { githubRepoUrl: true, phase: true },
    }),
    getLatestPlan(id),
  ]);

  // A deleted or mistyped id used to render the full workspace against nulls — an empty chat
  // beside an empty preview, which reads as a broken product rather than a dead link
  // (F-445). `not-found.tsx` in this segment keeps the workspace frame and offers a way out.
  if (!project) notFound();

  return (
    <GenerationWorkspace
      githubConnected={github.connected}
      githubRepoUrl={project.githubRepoUrl}
      initialPhase={project.phase}
      initialPlan={planResult.ok ? toWorkspacePlan(planResult.data) : null}
    />
  );
}
