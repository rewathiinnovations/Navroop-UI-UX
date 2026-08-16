import { extractDocument, isPlaceholderText } from '../html';
import { finding } from '../findings';
import type { SeoFinding, SeoScanInput } from '../types';

function titlesFromFiles(files: SeoScanInput['files']): string[] {
  const found: string[] = [];
  for (const file of files) {
    const htmlTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(file.content)?.[1];
    if (htmlTitle) found.push(htmlTitle.replace(/\s+/g, ' ').trim());
    const metaTitle = /title:\s*['"`]([^'"`]{3,})['"`]/.exec(file.content)?.[1];
    if (metaTitle) found.push(metaTitle.trim());
  }
  return found.filter(Boolean);
}

function descriptionsFromFiles(files: SeoScanInput['files']): string[] {
  const found: string[] = [];
  for (const file of files) {
    const meta = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(file.content)?.[1];
    if (meta) found.push(meta.trim());
    const field = /description:\s*['"`]([^'"`]{8,})['"`]/.exec(file.content)?.[1];
    if (field) found.push(field.trim());
  }
  return found.filter(Boolean);
}

export function checkMetadata(input: SeoScanInput): SeoFinding[] {
  const doc = extractDocument(input.live?.html || '');
  const fileTitles = titlesFromFiles(input.files);
  const fileDescriptions = descriptionsFromFiles(input.files);
  const title = doc.title || fileTitles[0] || '';
  const description = doc.description || fileDescriptions[0] || '';
  const canonical =
    doc.canonical ||
    input.files.some((file) => /rel=["']canonical["']|alternates:\s*\{[^}]*canonical/i.test(file.content));

  const findings: SeoFinding[] = [];

  if (!title) {
    findings.push(
      finding({
        id: 'metadata:title',
        category: 'metadata',
        status: 'medium',
        title: 'Page title is missing',
        detail: 'Every public route needs a unique title of 50-60 characters. No placeholders.',
      }),
    );
  } else if (isPlaceholderText(title)) {
    findings.push(
      finding({
        id: 'metadata:title',
        category: 'metadata',
        status: 'medium',
        title: 'Page title looks like a placeholder',
        detail: `Title "${title}" is generic. Write a unique 50-60 character title from the real topic.`,
      }),
    );
  } else {
    const length = title.length;
    findings.push(
      finding({
        id: 'metadata:title',
        category: 'metadata',
        status: length >= 50 && length <= 60 ? 'pass' : 'low',
        title: length >= 50 && length <= 60 ? 'Page title is unique and sized' : 'Page title length is off',
        detail:
          length >= 50 && length <= 60
            ? `Title is ${length} characters.`
            : `Title is ${length} characters (aim 50-60). "${title}"`,
        fixable: !(length >= 50 && length <= 60),
      }),
    );
  }

  if (!description) {
    findings.push(
      finding({
        id: 'metadata:description',
        category: 'metadata',
        status: 'medium',
        title: 'Meta description is missing',
        detail: 'Every public route needs a unique meta description of 140-160 characters.',
      }),
    );
  } else if (isPlaceholderText(description)) {
    findings.push(
      finding({
        id: 'metadata:description',
        category: 'metadata',
        status: 'medium',
        title: 'Meta description looks like a placeholder',
        detail: 'Replace placeholder copy with a unique 140-160 character description.',
      }),
    );
  } else {
    const length = description.length;
    findings.push(
      finding({
        id: 'metadata:description',
        category: 'metadata',
        status: length >= 140 && length <= 160 ? 'pass' : 'low',
        title: length >= 140 && length <= 160 ? 'Meta description is sized' : 'Meta description length is off',
        detail:
          length >= 140 && length <= 160
            ? `Description is ${length} characters.`
            : `Description is ${length} characters (aim 140-160).`,
        fixable: !(length >= 140 && length <= 160),
      }),
    );
  }

  findings.push(
    finding({
      id: 'metadata:canonical',
      category: 'metadata',
      status: canonical ? 'pass' : 'medium',
      title: canonical ? 'Canonical URL is set' : 'Canonical URL is missing',
      detail: canonical
        ? 'A canonical URL is present for this route.'
        : 'Add a per-route canonical so duplicates do not split indexing.',
    }),
  );

  const allTitles = [doc.title, ...fileTitles].filter(Boolean);
  const dupes = allTitles.filter((value, index) => allTitles.indexOf(value) !== index);
  if (new Set(allTitles).size > 0 && allTitles.length > 1 && new Set(allTitles).size < allTitles.length) {
    findings.push(
      finding({
        id: 'metadata:duplicate-title',
        category: 'metadata',
        status: 'medium',
        title: 'Duplicate titles across routes',
        detail: `Repeated titles: ${[...new Set(dupes)].join(', ') || allTitles[0]}. Each route needs a unique title.`,
      }),
    );
  }

  return findings;
}
