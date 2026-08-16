import type { SeoFinding, SeoSeverity } from './types';

export function finding(input: {
  id: string;
  category: SeoFinding['category'];
  status: SeoSeverity;
  title: string;
  detail: string;
  fixable?: boolean;
  ignored?: boolean;
}): SeoFinding {
  return {
    id: input.id,
    category: input.category,
    status: input.status,
    title: input.title,
    detail: input.detail,
    fixable: input.fixable ?? input.status !== 'pass',
    ignored: input.ignored ?? false,
  };
}

export function mergeIgnoredFindings(next: SeoFinding[], previous: SeoFinding[]): SeoFinding[] {
  const ignored = new Set(previous.filter((row) => row.ignored).map((row) => row.id));
  return next.map((row) => (ignored.has(row.id) ? { ...row, ignored: true, fixed: false } : { ...row, ignored: false }));
}

const STATUS_ORDER: Record<SeoSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  pass: 3,
};

export function sortFindings(findings: SeoFinding[]): SeoFinding[] {
  return [...findings].sort((left, right) => {
    if (left.ignored !== right.ignored) return left.ignored ? 1 : -1;
    if (left.status !== right.status) return STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
    return left.title.localeCompare(right.title);
  });
}

export function capLighthouseSeverity(status: SeoSeverity): SeoSeverity {
  if (status === 'high') return 'medium';
  return status;
}

export function asFindings(value: unknown): SeoFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Partial<SeoFinding>;
    if (typeof row.id !== 'string' || typeof row.title !== 'string') return [];
    const status = row.status;
    if (status !== 'pass' && status !== 'low' && status !== 'medium' && status !== 'high') return [];
    const category = row.category;
    if (
      category !== 'page-basics' &&
      category !== 'metadata' &&
      category !== 'open-graph' &&
      category !== 'structured-data' &&
      category !== 'robots' &&
      category !== 'sitemap' &&
      category !== 'indexing' &&
      category !== 'content-structure' &&
      category !== 'lighthouse'
    ) {
      return [];
    }
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
      },
    ];
  });
}
