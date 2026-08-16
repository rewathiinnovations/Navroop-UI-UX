import type { CodeFinding, CodeMetrics, CodeSeverity } from './types';

const CATEGORIES: CodeFinding['category'][] = [
  'typescript',
  'lint',
  'dependencies',
  'dead-code',
  'bundle',
  'a11y',
  'ai-review',
  'tool',
];

export function finding(input: {
  id: string;
  category: CodeFinding['category'];
  status: CodeSeverity;
  title: string;
  detail: string;
  fixable?: boolean;
  ignored?: boolean;
  filePath?: string;
  line?: number;
  selector?: string;
}): CodeFinding {
  return {
    id: input.id,
    category: input.category,
    status: input.status,
    title: input.title,
    detail: input.detail,
    fixable: input.fixable ?? input.status !== 'pass',
    ignored: input.ignored ?? false,
    ...(input.filePath ? { filePath: input.filePath } : {}),
    ...(typeof input.line === 'number' ? { line: input.line } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
  };
}

export function mergeIgnoredFindings(next: CodeFinding[], previous: CodeFinding[]): CodeFinding[] {
  const ignored = new Set(previous.filter((row) => row.ignored).map((row) => row.id));
  return next.map((row) => (ignored.has(row.id) ? { ...row, ignored: true, fixed: false } : { ...row, ignored: false }));
}

const STATUS_ORDER: Record<CodeSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  pass: 3,
};

export function sortFindings(findings: CodeFinding[]): CodeFinding[] {
  return [...findings].sort((left, right) => {
    if (left.ignored !== right.ignored) return left.ignored ? 1 : -1;
    if (left.status !== right.status) return STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
    return left.title.localeCompare(right.title);
  });
}

export function emptyMetrics(): CodeMetrics {
  return {
    bundleKb: null,
    tsErrors: 0,
    lintErrors: 0,
    a11yViolations: 0,
    unusedDeps: 0,
  };
}

export function asMetrics(value: unknown): CodeMetrics {
  if (!value || typeof value !== 'object') return emptyMetrics();
  const row = value as Partial<CodeMetrics>;
  return {
    bundleKb: typeof row.bundleKb === 'number' && Number.isFinite(row.bundleKb) ? row.bundleKb : null,
    tsErrors: Number.isFinite(row.tsErrors) ? Number(row.tsErrors) : 0,
    lintErrors: Number.isFinite(row.lintErrors) ? Number(row.lintErrors) : 0,
    a11yViolations: Number.isFinite(row.a11yViolations) ? Number(row.a11yViolations) : 0,
    unusedDeps: Number.isFinite(row.unusedDeps) ? Number(row.unusedDeps) : 0,
  };
}

export function metricsFromFindings(findings: CodeFinding[], bundleKb: number | null): CodeMetrics {
  const open = findings.filter((row) => !row.ignored && row.status !== 'pass');
  return {
    bundleKb,
    tsErrors: open.filter((row) => row.category === 'typescript').length,
    lintErrors: open.filter((row) => row.category === 'lint').length,
    a11yViolations: open.filter((row) => row.category === 'a11y').length,
    unusedDeps: open.filter((row) => row.category === 'dependencies' && /unused/i.test(row.title)).length,
  };
}

export function asCodeFindings(value: unknown): CodeFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Partial<CodeFinding>;
    if (typeof row.id !== 'string' || typeof row.title !== 'string') return [];
    const status = row.status;
    if (status !== 'pass' && status !== 'low' && status !== 'medium' && status !== 'high') return [];
    const category = row.category;
    if (!category || !CATEGORIES.includes(category)) return [];
    return [
      {
        id: row.id,
        category,
        status,
        title: row.title,
        detail: typeof row.detail === 'string' ? row.detail : '',
        fixable: row.fixable !== false,
        ignored: row.ignored === true,
        fixed: row.fixed === true,
        ...(typeof row.filePath === 'string' ? { filePath: row.filePath } : {}),
        ...(typeof row.line === 'number' ? { line: row.line } : {}),
        ...(typeof row.selector === 'string' ? { selector: row.selector } : {}),
      },
    ];
  });
}

export function stripSandboxPrefix(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\/home\/user\/app\//, '')
    .replace(/^\/vercel\/sandbox\//, '')
    .replace(/^\.?\//, '');
}
