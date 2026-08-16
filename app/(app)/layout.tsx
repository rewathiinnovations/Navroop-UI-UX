import { Suspense, type ReactNode } from 'react';
import { CommandPaletteProvider } from '@/components/layout/CommandPalette';
import Sidebar from '@/components/layout/Sidebar';
import { getRecentProjects, getWorkspaceMeta } from '@/lib/projects/stars';
import '@/components/app/studio/studio.css';

export default async function AppGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  const [recentResult, workspaceResult] = await Promise.all([
    getRecentProjects(5),
    getWorkspaceMeta(),
  ]);

  const recents = recentResult.ok ? recentResult.data.projects : [];
  const teamName = workspaceResult.ok ? workspaceResult.data.teamName : 'Navroop';
  const memberCount = workspaceResult.ok ? workspaceResult.data.memberCount : 0;

  return (
    <div className="studio-shell relative flex h-dvh overflow-hidden">
      <div className="studio-glow" aria-hidden />
      <CommandPaletteProvider>
        <Suspense fallback={<div className="h-full w-[272px] shrink-0 border-r border-[var(--studio-line)]" />}>
          <Sidebar teamName={teamName} memberCount={memberCount} recents={recents} />
        </Suspense>
        <div className="relative z-10 min-w-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </CommandPaletteProvider>
    </div>
  );
}
