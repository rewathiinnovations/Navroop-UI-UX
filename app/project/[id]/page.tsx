import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { getGitHubConnectionStatus } from '@/lib/github/actions';
import { getLatestPlan } from '@/lib/projects/plan';
import { toWorkspacePlan } from '@/components/workspace/types';
import GenerationPage from '../../generation/page';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const userId = session?.user?.id;

  const [github, project, planResult] = await Promise.all([
    userId ? getGitHubConnectionStatus(userId) : Promise.resolve({ connected: false as const }),
    prisma.project.findFirst({
      where: { id, deletedAt: null },
      select: { githubRepoUrl: true, phase: true },
    }),
    getLatestPlan(id),
  ]);

  return (
    <GenerationPage
      githubConnected={github.connected}
      githubRepoUrl={project?.githubRepoUrl ?? null}
      initialPhase={project?.phase ?? null}
      initialPlan={planResult.ok ? toWorkspacePlan(planResult.data) : null}
    />
  );
}
