import { finding } from '../findings';
import type { SeoFinding, SeoScanInput } from '../types';

function robotsSource(input: SeoScanInput): string {
  if (input.liveRobots?.text) return input.liveRobots.text;
  const file = input.files.find((row) => /(?:^|\/)robots\.(txt|ts|js)$/i.test(row.path.replace(/\\/g, '/')));
  return file?.content || '';
}

function hasRobotsFile(input: SeoScanInput): boolean {
  if (input.liveRobots && input.liveRobots.status >= 200 && input.liveRobots.status < 400 && input.liveRobots.text.trim()) {
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

function isSitewideBlock(text: string): boolean {
  const normalized = text.replace(/\r/g, '\n');
  const disallowAll = /(?:^|\n)\s*disallow:\s*\/\s*(?:\n|$)/i.test(normalized);
  const allowRoot = /(?:^|\n)\s*allow:\s*\/\s*(?:\n|$)/i.test(normalized);
  return disallowAll && !allowRoot;
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
