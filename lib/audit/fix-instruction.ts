import { sortFindings } from './findings';
import type { CodeFinding } from './types';

function openFindings(findings: CodeFinding[]): CodeFinding[] {
  return sortFindings(findings).filter((row) => !row.ignored && row.status !== 'pass' && row.fixable !== false);
}

function locate(target: CodeFinding): string {
  if (target.filePath && typeof target.line === 'number') return `${target.filePath}:${target.line}`;
  if (target.filePath) return target.filePath;
  if (target.selector) return `selector ${target.selector}`;
  return '';
}

export function buildFixInstruction(target: CodeFinding): string {
  const where = locate(target);
  return [
    'Fix this code-quality / performance issue in the generated site. This is a build edit — change only the files required.',
    `Issue: ${target.title}`,
    `Detail: ${target.detail}`,
    `Category: ${target.category}`,
    where ? `Location: ${where}` : '',
    'Keep the existing stack, design direction, and SEO rules. Do not introduce placeholders.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildFixAllInstruction(findings: CodeFinding[]): string {
  const open = openFindings(findings);
  const list = open
    .map((row, index) => {
      const where = locate(row);
      return `${index + 1}. [${row.category} / ${row.status}] ${row.title}${where ? ` (${where})` : ''} — ${row.detail}`;
    })
    .join('\n');
  return [
    'Fix these code-quality / performance issues together in one edit, in severity order (high, then medium, then low). Change only the files required.',
    list || 'No open code findings.',
    'Keep the existing stack, design direction, and SEO rules. Do not introduce placeholders.',
  ].join('\n\n');
}
