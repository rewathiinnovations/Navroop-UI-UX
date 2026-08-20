import { finding } from '../findings';
import type { SeoFinding, SeoScanInput } from '../types';

function robotsSource(input: SeoScanInput): string {
  if (input.liveRobots?.text) return input.liveRobots.text;
  const file = input.files.find((row) =>
    /(?:^|\/)robots\.(txt|ts|js)$/i.test(row.path.replace(/\\/g, '/')),
  );
  return file?.content || '';
}

function hasRobotsFile(input: SeoScanInput): boolean {
  if (
    input.liveRobots &&
    input.liveRobots.status >= 200 &&
    input.liveRobots.status < 400 &&
    input.liveRobots.text.trim()
  ) {
    return true;
  }
  return input.files.some((row) => {
    const path = row.path.replace(/\\/g, '/');
    return (
      /(?:^|\/)robots\.txt$/i.test(path) ||
      /(?:^|\/)app\/robots\.(ts|js)$/i.test(path) ||
      /(?:^|\/)src\/app\/robots\.(ts|js)$/i.test(path)
    );
  });
}

type RobotsGroup = { agents: string[]; disallowRoot: boolean; allowRoot: boolean };

/**
 * robots.txt is a list of groups: one or more consecutive `User-agent` lines followed by
 * the rules that apply to them. A rule belongs to its group and to no other, which is the
 * whole point of the format — and what this check used to ignore (F-756).
 */
function parseRobotsGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // A `User-agent` line following another one extends the same group; one following a rule
  // starts a new group.
  let collectingAgents = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!current || !collectingAgents) {
        current = { agents: [], disallowRoot: false, allowRoot: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }
    // `Sitemap`, `Crawl-delay` and `Host` are not group rules and must not end a group's
    // agent list either — only an Allow/Disallow does that.
    if (field !== 'allow' && field !== 'disallow') continue;
    // A rule before any `User-agent` line applies to nobody.
    if (!current) continue;
    collectingAgents = false;
    // Only the root path decides "the whole site"; `Disallow:` with no value means the
    // opposite, and `/admin/` is a normal exclusion.
    if (value !== '/') continue;
    if (field === 'disallow') current.disallowRoot = true;
    else current.allowRoot = true;
  }
  return groups;
}

function isSitewideBlock(text: string): boolean {
  // Only the group that applies to every crawler can hide the whole site. `User-agent:
  // GPTBot` / `Disallow: /` is a deliberate configuration, not a defect, and an `Allow: /`
  // under some other agent must not silence a real `*` block. Duplicate `*` groups are
  // merged the way a crawler merges them.
  const wildcard = parseRobotsGroups(text).filter((group) => group.agents.includes('*'));
  if (wildcard.length === 0) return false;
  const disallowRoot = wildcard.some((group) => group.disallowRoot);
  const allowRoot = wildcard.some((group) => group.allowRoot);
  return disallowRoot && !allowRoot;
}

export function checkRobots(input: SeoScanInput): SeoFinding[] {
  const text = robotsSource(input);
  if (!hasRobotsFile(input) && !text.trim()) {
    return [
      finding({
        id: 'robots:missing',
        category: 'robots',
        status: 'medium',
        title: 'robots.txt is missing',
        detail:
          input.stack === 'NEXTJS'
            ? 'Add app/robots.ts (or robots.txt) that allows public pages and points at the sitemap.'
            : 'Add robots.txt that allows public pages and points at the sitemap.',
      }),
    ];
  }

  if (isSitewideBlock(text)) {
    return [
      finding({
        id: 'robots:blocked',
        category: 'robots',
        status: 'high',
        title: 'robots.txt blocks the whole site',
        detail: 'User-agent: * Disallow: / hides every URL from crawlers. Allow public routes.',
      }),
    ];
  }

  return [
    finding({
      id: 'robots:present',
      category: 'robots',
      status: 'pass',
      title: 'robots.txt is present',
      detail: 'A robots file exists and does not sitewide-block crawlers.',
      fixable: false,
    }),
  ];
}
