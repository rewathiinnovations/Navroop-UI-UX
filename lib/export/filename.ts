export function slugifyExportName(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

export function buildExportFilename(name: string, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return `${slugifyExportName(name)}-${day}.zip`;
}
