import { extractDocument } from '../html';
import { finding } from '../findings';
import type { SeoFinding, SeoScanInput } from '../types';

export function checkOpenGraph(input: SeoScanInput): SeoFinding[] {
  const doc = extractDocument(input.live?.html || '');
  const blob = `${input.live?.html || ''}\n${input.files.map((file) => file.content).join('\n')}`;
  const ogTitle = doc.og['og:title'] || /og:title/.test(blob);
  const ogDescription = doc.og['og:description'] || /og:description/.test(blob);
  const ogImage = doc.og['og:image'] || /og:image/.test(blob);
  const twitterCard = (doc.twitter['twitter:card'] || /twitter:card["'\s:=]+["']?([a-z_]+)/i.exec(blob)?.[1] || '').toLowerCase();

  const missing: string[] = [];
  if (!ogTitle) missing.push('og:title');
  if (!ogDescription) missing.push('og:description');
  if (!ogImage) missing.push('og:image');

  const findings: SeoFinding[] = [
    finding({
      id: 'open-graph:tags',
      category: 'open-graph',
      status: missing.length === 0 ? 'pass' : 'medium',
      title: missing.length === 0 ? 'Open Graph tags are present' : 'Open Graph tags are incomplete',
      detail:
        missing.length === 0
          ? 'og:title, og:description, and og:image are set for this route.'
          : `Missing ${missing.join(', ')}. Add OG tags per public route.`,
    }),
    finding({
      id: 'open-graph:twitter-card',
      category: 'open-graph',
      status: twitterCard === 'summary_large_image' ? 'pass' : twitterCard ? 'low' : 'medium',
      title:
        twitterCard === 'summary_large_image'
          ? 'Twitter card is summary_large_image'
          : twitterCard
            ? 'Twitter card is not summary_large_image'
            : 'Twitter card is missing',
      detail:
        twitterCard === 'summary_large_image'
          ? 'twitter:card is summary_large_image.'
          : 'Set twitter:card to summary_large_image and include twitter:title, twitter:description, and twitter:image.',
    }),
  ];

  return findings;
}
