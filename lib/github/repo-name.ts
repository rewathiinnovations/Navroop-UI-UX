import { randomBytes } from 'node:crypto';

export function slugifyRepoName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'project';
}

export function uniqueRepoName(name: string) {
  return `${slugifyRepoName(name)}-${randomBytes(3).toString('hex')}`;
}
