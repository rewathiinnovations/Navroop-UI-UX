'use client';

import StudioShell from '@/components/app/studio/StudioShell';
import PageTabs from '@/components/app/studio/PageTabs';
import SkillsPanel from '@/components/settings/SkillsPanel';

export default function SkillsSettingsPage() {
  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[640px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">Settings</h1>
        <PageTabs
          items={[
            { href: '/settings/profile', label: 'Profile' },
            { href: '/settings/api-keys', label: 'API Keys' },
            { href: '/settings/skills', label: 'Skills', active: true },
          ]}
        />
        <p className="mb-16 text-[13px] text-[var(--studio-muted)]">
          Skills also live as a section in the workspace Brain tab, next to always-on memory.
        </p>
        <SkillsPanel />
      </main>
    </StudioShell>
  );
}
