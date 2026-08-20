import { extractDocument, isPlaceholderText } from '../html';
import { finding } from '../findings';
import { CANONICAL_DECLARATION, metadataFiles, scopedVerdict } from '../source-scope';
import type { SeoFinding, SeoScanInput } from '../types';

/**
 * One title per file, not per match: a route that declares both an HTML
 * `<title>` and a `title:` metadata field is still one route, and counting it
 * twice would make every such file its own duplicate.
 */
function titlesFromFiles(files: SeoScanInput['files']): Array<{ path: string; title: string }> {
  const found: Array<{ path: string; title: string }> = [];
  for (const file of files) {
    const htmlTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(file.content)?.[1];
    const metaTitle = /title:\s*['"`]([^'"`]{3,})['"`]/.exec(file.content)?.[1];
    const title = (htmlTitle || metaTitle || '').replace(/\s+/g, ' ').trim();
    if (title) found.push({ path: file.path.replace(/\\/g, '/'), title });
  }
  return found;
}

function descriptionsFromFiles(files: SeoScanInput['files']): string[] {
  const found: string[] = [];
  for (const file of files) {
    const meta = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(
      file.content,
    )?.[1];
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
  const title = doc.title || fileTitles[0]?.title || '';
  const description = doc.description || fileDescriptions[0] || '';
  // Scoped to the files that can own route metadata: `rel="canonical"` appearing
  // in any file at all — a helper, a comment, a docs page — used to pass this
  // (F-731).
  const canonical = doc.canonical
    ? true
    : scopedVerdict(metadataFiles(input.files), CANONICAL_DECLARATION);

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
        title:
          length >= 50 && length <= 60
            ? 'Page title is unique and sized'
            : 'Page title length is off',
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
        title:
          length >= 140 && length <= 160
            ? 'Meta description is sized'
            : 'Meta description length is off',
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
      status: canonical === null ? 'info' : canonical ? 'pass' : 'medium',
      title:
        canonical === null
          ? 'Canonical URL could not be checked'
          : canonical
            ? 'Canonical URL is set'
            : 'Canonical URL is missing',
      detail:
        canonical === null
          ? 'No preview responded and the snapshot has no file that declares route metadata, so nothing here sets a canonical either way.'
          : canonical
            ? 'A canonical URL is present for this route.'
            : 'Add a per-route canonical so duplicates do not split indexing.',
      fixable: canonical === false,
    }),
  );

  // Duplicates are counted across *files*, never against the live page.
  //
  // `allTitles` used to be `[doc.title, ...fileTitles]`, and `doc.title` is the
  // rendered homepage — necessarily equal to whichever source title produced
  // it. The set was therefore always smaller than the list whenever a preview
  // existed and any title was extracted, so this fired on single-page projects
  // and on projects whose routes all had distinct titles: true in every case it
  // was meant to tell apart, and carrying no information (F-731). Two source
  // files declaring the same title is the thing that is actually a defect.
  const byTitle = new Map<string, string[]>();
  for (const row of fileTitles) {
    byTitle.set(row.title, [...(byTitle.get(row.title) ?? []), row.path]);
  }
  const repeated = [...byTitle.entries()].filter(([, paths]) => paths.length > 1);
  if (repeated.length > 0) {
    findings.push(
      finding({
        id: 'metadata:duplicate-title',
        category: 'metadata',
        status: 'medium',
        title: 'Duplicate titles across routes',
        detail: repeated
          .map(([value, paths]) => `"${value}" in ${paths.join(', ')}`)
          .join('; ')
          .concat('. Each route needs a unique title.'),
      }),
    );
  }

  return findings;
}
