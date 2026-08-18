import {
  Activity,
  Archive,
  BarChart3,
  Building2,
  Cpu,
  Gauge,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  Plug,
  ScrollText,
  Server,
  SlidersHorizontal,
  Users,
  Layers,
  type LucideIcon,
} from 'lucide-react';
import type { AdminIconName } from './admin-nav';

const ICONS: Record<AdminIconName, LucideIcon> = {
  home: LayoutDashboard,
  health: Activity,
  team: Users,
  plans: Layers,
  config: SlidersHorizontal,
  integrations: Plug,
  templates: LayoutTemplate,
  workspace: Building2,
  'sandbox-providers': Cpu,
  servers: Server,
  backups: Archive,
  jobs: ListChecks,
  usage: BarChart3,
  quality: Gauge,
  audit: ScrollText,
};

export default function AdminIcon({
  name,
  className,
}: {
  name: AdminIconName;
  className?: string;
}) {
  const Icon = ICONS[name];
  return <Icon className={className} aria-hidden />;
}
