import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { getGitHubConnectionStatusForUser } from '@/lib/github/connection';
import { getLatestPlan } from '@/lib/projects/plan';
import { toWorkspacePlan } from '@/components/workspace/types';
import GenerationWorkspace from '@/components/workspace/GenerationWorkspace';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const userId = session?.user?.id;

  const [github, project, planResult] = await Promise.all([
    userId
      ? getGitHubConnectionStatusForUser(prisma, userId)
      : Promise.resolve({ connected: false as const }),
    prisma.project.findFirst({
      where: { id, deletedAt: null },
      select: { githubRepoUrl: true, phase: true },
    }),
    getLatestPlan(id),
  ]);

  return (
    <GenerationWorkspace
      githubConnected={github.connected}
      githubRepoUrl={project?.githubRepoUrl ?? null}
      initialPhase={project?.phase ?? null}
      initialPlan={planResult.ok ? toWorkspacePlan(planResult.data) : null}
    />
  );
}
