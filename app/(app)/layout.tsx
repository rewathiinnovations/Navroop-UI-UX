import { Suspense, type ReactNode } from 'react';
import AppShell from '@/components/layout/AppShell';
import Sidebar from '@/components/layout/Sidebar';
import { getSessionUser } from '@/lib/auth';
import { withRelativeLabels } from '@/lib/format-relative-time';
import { getRecentProjects, getWorkspaceMeta } from '@/lib/projects/stars';
import '@/components/app/studio/studio.css';

export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const [recentResult, workspaceResult, sessionUser] = await Promise.all([
    getRecentProjects(5),
    getWorkspaceMeta(),
    getSessionUser(),
  ]);

  const recents = withRelativeLabels(recentResult.ok ? recentResult.data.projects : []);
  const teamName = workspaceResult.ok ? workspaceResult.data.teamName : 'Navroop';
  const memberCount = workspaceResult.ok ? workspaceResult.data.memberCount : 0;

  return (
    <AppShell
      sidebar={
        <Suspense
          fallback={
            <div className="h-full min-h-0 w-[272px] shrink-0 border-r border-[var(--studio-line)]" />
          }
        >
          <Sidebar
            teamName={teamName}
            memberCount={memberCount}
            recents={recents}
            isAdmin={sessionUser?.role === 'ADMIN'}
          />
        </Suspense>
      }
    >
      {children}
    </AppShell>
  );
}
