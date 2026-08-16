'use client';

import { Plus } from 'lucide-react';
import StudioLogo from './StudioLogo';
import StudioButton from './StudioButton';
import UserMenu from './UserMenu';

export default function AppHeader({
  onNewProject,
  newProjectHref = '/dashboard#new',
}: {
  onNewProject?: () => void;
  newProjectHref?: string;
}) {
  return (
    <header className="relative z-10 sticky top-0 border-b border-[var(--studio-line)] bg-[var(--studio-header-bg)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1120px] items-center justify-between px-20 py-10">
        <StudioLogo href="/dashboard" />
        <div className="flex items-center gap-8">
          {onNewProject ? (
            <StudioButton variant="primary" onClick={onNewProject}>
              <Plus className="size-16" aria-hidden />
              New Project
            </StudioButton>
          ) : (
            <StudioButton variant="primary" href={newProjectHref}>
              <Plus className="size-16" aria-hidden />
              New Project
            </StudioButton>
          )}
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
