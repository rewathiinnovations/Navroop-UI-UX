import { asCodeFindings } from './findings';
import type { CodeFinding } from './types';

export type RecurringIssue = {
  category: CodeFinding['category'];
  count: number;
  sampleTitle: string;
};

/**
 * The `tool` category is not a finding about anyone's code.
 *
 * Every row in it is a statement about the installation: "typescript check could not run",
 * "Accessibility check is unavailable on this deployment", "AI code review not run yet".
 * They are counted per audit and this function's output is the operator's "top recurring
 * issues in generated code" panel on /admin/quality and /admin/usage, whose whole purpose
 * (see `getTopRecurringIssues`) is deciding what the generation prompts should teach the
 * model. A missing build runner is the same fact repeated once per project per build, so
 * within a day it outweighs every real category and pushes them out of the top slice — the
 * panel then reports the platform's own gaps back to the operator as though the model had
 * written them, and no prompt change can ever make the number go down.
 */
const PLATFORM_CATEGORY: CodeFinding['category'] = 'tool';

export function groupRecurringIssues(
  audits: Array<{ findings: unknown }>,
  limit = 8,
): RecurringIssue[] {
  const counts = new Map<CodeFinding['category'], { count: number; sampleTitle: string }>();
  for (const audit of audits) {
    for (const row of asCodeFindings(audit.findings)) {
      if (row.status === 'pass' || row.ignored) continue;
      // Filtered here rather than at the query, because the rows already stored carry these
      // findings: a scan that stops writing them today does nothing about the 200 audits
      // this reads back.
      if (row.category === PLATFORM_CATEGORY) continue;
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
