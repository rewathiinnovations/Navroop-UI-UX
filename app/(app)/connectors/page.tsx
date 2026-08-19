import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import StudioShell from '@/components/app/studio/StudioShell';
import ConnectorsGitHubCard from '@/components/connectors/ConnectorsGitHubCard';
import { loginModalHref } from '@/lib/auth/public-login';
import { prisma } from '@/lib/db';
import { getGitHubConnectionStatusForUser } from '@/lib/github/connection';

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<{ github?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(loginModalHref('/connectors'));
  }

  const status = await getGitHubConnectionStatusForUser(prisma, session.user.id);
  const params = await searchParams;
  const banner =
    params.github === 'connected'
      ? 'connected'
      : params.github === 'unconfigured'
        ? 'unconfigured'
        : params.github === 'error'
          ? 'error'
          : null;
  const isAdmin = session.user.role === 'ADMIN';

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[640px] px-20 py-56">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
          Connectors
        </h1>
        <ConnectorsGitHubCard
          connected={status.connected}
          githubUsername={status.connected ? status.githubUsername : undefined}
          banner={banner}
          isAdmin={isAdmin}
        />
      </main>
    </StudioShell>
  );
}
