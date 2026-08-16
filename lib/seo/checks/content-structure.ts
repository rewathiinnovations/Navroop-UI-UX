import { extractDocument } from '../html';
import { finding } from '../findings';
import type { SeoFinding, SeoScanInput } from '../types';

export function checkContentStructure(input: SeoScanInput): SeoFinding[] {
  const html = input.live?.html || input.files.find((file) => /\.html?$/i.test(file.path))?.content || '';
  const doc = extractDocument(html);
  const h1Count = doc.h1.length || (html.match(/<h1\b/gi) || []).length;
  const landmarks = [doc.hasNav, doc.hasMain, doc.hasFooter].filter(Boolean).length;

  return [
    finding({
      id: 'content-structure:h1',
      category: 'content-structure',
      status: h1Count === 1 ? 'pass' : h1Count === 0 ? 'medium' : 'low',
      title: h1Count === 1 ? 'Page has one h1' : h1Count === 0 ? 'Page is missing an h1' : 'Page has multiple h1s',
      detail:
        h1Count === 1
          ? 'A single h1 is present.'
          : 'Use exactly one h1 that names the page topic. Do not skip heading levels.',
    }),
    finding({
      id: 'content-structure:landmarks',
      category: 'content-structure',
      status: landmarks >= 2 ? 'pass' : 'low',
      title: landmarks >= 2 ? 'Landmarks are present' : 'Landmarks are incomplete',
      detail:
        landmarks >= 2
          ? 'Semantic landmarks (nav/main/footer) are present.'
          : 'Add nav, main, and footer landmarks so crawlers and assistive tech can outline the page.',
    }),
  ];
}
