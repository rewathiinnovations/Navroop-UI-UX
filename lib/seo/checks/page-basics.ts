import { extractDocument } from '../html';
import { finding } from '../findings';
import type { SeoFinding, SeoScanInput } from '../types';

export function checkPageBasics(input: SeoScanInput): SeoFinding[] {
  const html = input.live?.html || input.files.find((file) => /\.html?$/i.test(file.path))?.content || '';
  const doc = extractDocument(html);
  const fileBlob = input.files.map((file) => file.content).join('\n');
  const lang = doc.lang || /lang=["']([a-zA-Z-]+)["']/.exec(fileBlob)?.[1] || '';
  const viewport = doc.viewport || /viewport/i.test(fileBlob);

  return [
    finding({
      id: 'page-basics:html-lang',
      category: 'page-basics',
      status: lang ? 'pass' : 'medium',
      title: lang ? 'html lang is set' : 'html lang is missing',
      detail: lang
        ? `Document language is "${lang}".`
        : 'Set lang on the root <html> element (for example lang="en") so assistive tech and crawlers know the language.',
    }),
    finding({
      id: 'page-basics:viewport',
      category: 'page-basics',
      status: viewport ? 'pass' : 'medium',
      title: viewport ? 'Viewport meta is set' : 'Viewport meta is missing',
      detail: viewport
        ? 'Viewport meta is present.'
        : 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> so mobile crawlers and browsers size the page correctly.',
    }),
  ];
}
