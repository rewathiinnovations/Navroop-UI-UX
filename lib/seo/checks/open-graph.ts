import { extractDocument } from '../html';
import { finding } from '../findings';
import { metadataFiles, openGraphDeclaration, scopedVerdict } from '../source-scope';
import type { SeoFinding, SeoScanInput } from '../types';

const TWITTER_CARD_META = /twitter:card["'\s:=]+["']?([a-z_]+)/i;
/** Next's metadata object: `twitter: { card: 'summary_large_image' }`. */
const TWITTER_CARD_FIELD = /twitter\s*:\s*\{[\s\S]{0,600}?\bcard\s*:\s*['"`]([a-z_]+)['"`]/i;

export function checkOpenGraph(input: SeoScanInput): SeoFinding[] {
  const doc = extractDocument(input.live?.html || '');
  // Only the files that can own metadata, and only a real declaration. The old
  // check tested `/og:title/` against every file in the project concatenated
  // together, so the string appearing in any helper passed it (F-731).
  const scoped = metadataFiles(input.files);
  const verdicts = (['og:title', 'og:description', 'og:image'] as const).map((property) => ({
    property,
    present: doc.og[property] ? true : scopedVerdict(scoped, openGraphDeclaration(property)),
  }));
  const missing = verdicts.filter((row) => row.present === false).map((row) => row.property);
  const unknown = verdicts.filter((row) => row.present === null).map((row) => row.property);

  const twitterCard = (
    doc.twitter['twitter:card'] ||
    scoped
      .map(
        (file) =>
          TWITTER_CARD_META.exec(file.content)?.[1] || TWITTER_CARD_FIELD.exec(file.content)?.[1],
      )
      .find(Boolean) ||
    ''
  ).toLowerCase();
  const twitterUnknown = !twitterCard && !input.live && scoped.length === 0;

  return [
    finding({
      id: 'open-graph:tags',
      category: 'open-graph',
      status: missing.length > 0 ? 'medium' : unknown.length > 0 ? 'info' : 'pass',
      title:
        missing.length > 0
          ? 'Open Graph tags are incomplete'
          : unknown.length > 0
            ? 'Open Graph tags could not be checked'
            : 'Open Graph tags are present',
      detail:
        missing.length > 0
          ? `Missing ${missing.join(', ')}. Add OG tags per public route.`
          : unknown.length > 0
            ? `No preview responded and the snapshot has no file that declares route metadata, so ${unknown.join(', ')} could not be checked.`
            : 'og:title, og:description, and og:image are set for this route.',
      fixable: missing.length > 0,
    }),
    finding({
      id: 'open-graph:twitter-card',
      category: 'open-graph',
      status:
        twitterCard === 'summary_large_image'
          ? 'pass'
          : twitterCard
            ? 'low'
            : twitterUnknown
              ? 'info'
              : 'medium',
      title:
        twitterCard === 'summary_large_image'
          ? 'Twitter card is summary_large_image'
          : twitterCard
            ? 'Twitter card is not summary_large_image'
            : twitterUnknown
              ? 'Twitter card could not be checked'
              : 'Twitter card is missing',
      detail: twitterUnknown
        ? 'No preview responded and the snapshot has no file that declares route metadata, so the Twitter card could not be checked.'
        : twitterCard === 'summary_large_image'
          ? 'twitter:card is summary_large_image.'
          : 'Set twitter:card to summary_large_image and include twitter:title, twitter:description, and twitter:image.',
      fixable: !twitterUnknown && twitterCard !== 'summary_large_image',
    }),
  ];
}
