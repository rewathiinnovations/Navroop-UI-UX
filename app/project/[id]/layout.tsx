import type { ReactNode } from 'react';
import '@/components/app/studio/studio.css';

/** Full-viewport project workspace. No Sidebar — this route is outside (app). */
export default function ProjectLayout({ children }: { children: ReactNode }) {
  return <div className="studio-shell h-dvh overflow-hidden">{children}</div>;
}
