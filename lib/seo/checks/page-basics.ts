import { extractDocument } from '../html';
import { finding } from '../findings';
import { VIEWPORT_DECLARATION, rootDocumentFiles, scopedVerdict } from '../source-scope';
import type { SeoFinding, SeoScanInput } from '../types';

export function checkPageBasics(input: SeoScanInput): SeoFinding[] {
  const html =
    input.live?.html || input.files.find((file) => /\.html?$/i.test(file.path))?.content || '';
  const doc = extractDocument(html);
  const fileBlob = input.files.map((file) => file.content).join('\n');
  const lang = doc.lang || /lang=["']([a-zA-Z-]+)["']/.exec(fileBlob)?.[1] || '';
  // `doc.viewport` is the live page. With no live page only the root document
  // can answer: the old check ran `/viewport/i` over every file concatenated,
  // so a CSS comment mentioning the word passed it (F-731).
  const viewport = doc.viewport
    ? true
    : scopedVerdict(rootDocumentFiles(input.files), VIEWPORT_DECLARATION);

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
      status: viewport === null ? 'info' : viewport ? 'pass' : 'medium',
      title:
        viewport === null
          ? 'Viewport meta could not be checked'
          : viewport
            ? 'Viewport meta is set'
            : 'Viewport meta is missing',
      detail:
        viewport === null
          ? 'No preview responded and the snapshot has no root document (index.html, app/layout, pages/_document), so nothing here declares the viewport either way.'
          : viewport
            ? 'Viewport meta is present.'
            : 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> so mobile crawlers and browsers size the page correctly.',
      fixable: viewport === false,
    }),
  ];
}
