import { asCodeFindings } from './findings';
import type { CodeFinding } from './types';

export type RecurringIssue = {
  category: CodeFinding['category'];
  count: number;
  sampleTitle: string;
};

export function groupRecurringIssues(
  audits: Array<{ findings: unknown }>,
  limit = 8,
): RecurringIssue[] {
  const counts = new Map<CodeFinding['category'], { count: number; sampleTitle: string }>();
  for (const audit of audits) {
    for (const row of asCodeFindings(audit.findings)) {
      if (row.status === 'pass' || row.ignored) continue;
      const current = counts.get(row.category) || { count: 0, sampleTitle: row.title };
      current.count += 1;
      counts.set(row.category, current);
    }
  }
  return [...counts.entries()]
    .map(([category, value]) => ({ category, count: value.count, sampleTitle: value.sampleTitle }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
    .slice(0, limit);
}
