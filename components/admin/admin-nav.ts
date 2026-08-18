/**
 * The single definition of admin navigation.
 *
 * This list previously existed in six places that had drifted apart, so the tab
 * strip changed length and order as you moved between pages and two sections
 * were unreachable by clicking. Every admin surface — the sidebar, the home
 * page cards, the page titles — now renders from here, so adding a section is
 * one edit and cannot go missing.
 *
 * `description` is written for someone who has not read the code. It is shown
 * on the admin home and as the nav tooltip.
 */

export type AdminNavItem = {
  href: string;
  label: string;
  description: string;
};

export type AdminNavGroup = {
  group: string;
  items: AdminNavItem[];
};

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    group: 'Overview',
    items: [
      {
        href: '/admin',
        label: 'Home',
        description: 'What needs attention right now, and where everything lives.',
      },
      {
        href: '/admin/health',
        label: 'Health',
        description: 'Whether this installation is running correctly: release, storage, error tracking, and provider checks.',
      },
    ],
  },
  {
    group: 'People',
    items: [
      {
        href: '/admin/team',
        label: 'Team',
        description: 'Who can sign in, what role they hold, and how to invite or deactivate them.',
      },
      {
        href: '/admin/plans',
        label: 'Plans',
        description: 'How much each plan may generate, and which members are on it.',
      },
    ],
  },
  {
    group: 'Configuration',
    items: [
      {
        href: '/admin/config',
        label: 'Configuration',
        description: 'Every API key and setting this installation needs. Replaces editing environment files by hand.',
      },
      {
        href: '/admin/integrations',
        label: 'Integrations',
        description: 'Connect GitHub, Cloudflare, Coolify, and Sentry so projects can be published and monitored.',
      },
      {
        href: '/admin/templates',
        label: 'Templates',
        description: 'The starting points members can pick when creating a project.',
      },
      {
        href: '/admin/workspace',
        label: 'Workspace',
        description: 'Spending caps for the whole workspace, and the switch that stops all generation at once.',
      },
    ],
  },
  {
    group: 'Infrastructure',
    items: [
      {
        href: '/admin/sandbox-providers',
        label: 'Sandbox providers',
        description: 'Which service runs generated code, and the order they are tried when one is unavailable.',
      },
      {
        href: '/admin/servers',
        label: 'Servers',
        description: 'The machines available to host published sites.',
      },
      {
        href: '/admin/backups',
        label: 'Backups',
        description: 'When the database was last backed up, and how to restore it.',
      },
      {
        href: '/admin/jobs',
        label: 'Jobs',
        description: 'Generation work in progress, and anything that stalled or failed.',
      },
    ],
  },
  {
    group: 'Insights',
    items: [
      {
        href: '/admin/usage',
        label: 'Usage',
        description: 'What was generated, by whom, and what it cost.',
      },
      {
        href: '/admin/quality',
        label: 'Quality',
        description: 'How well generation is performing over time, and the problems that keep recurring.',
      },
      {
        href: '/admin/audit',
        label: 'Audit log',
        description: 'A record of every administrative action taken, and by whom.',
      },
    ],
  },
];

export const ADMIN_NAV_ITEMS: AdminNavItem[] = ADMIN_NAV.flatMap((group) => group.items);

export function findAdminNavItem(pathname: string): AdminNavItem | undefined {
  return ADMIN_NAV_ITEMS.find((item) => item.href === pathname);
}

/**
 * `/admin` must match exactly or it would claim every nested route as active.
 */
export function isAdminNavItemActive(item: AdminNavItem, pathname: string) {
  if (item.href === '/admin') return pathname === '/admin';
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
