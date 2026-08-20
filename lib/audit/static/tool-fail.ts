import { finding } from '../findings';
import type { CodeFinding } from '../types';

export function toolFailedFinding(tool: string, error: unknown): CodeFinding {
  const message = error instanceof Error ? error.message : String(error || 'unknown error');
  return finding({
    id: toolFailedId(tool),
    category: 'tool',
    status: 'low',
    title: `${tool} check could not run`,
    detail: `Informational only — ${tool} failed (${message}). The rest of the audit continued.`,
    fixable: false,
  });
}

export function toolFailedId(tool: string): string {
  return `tool:${tool}`;
}

/**
 * Did this tool fail to run at all? A quality signal derived from counting
 * findings cannot tell "clean" from "never executed" — both are zero findings —
 * so the collectors ask here instead of recording a perfect score (F-705).
 */
export function toolFailed(findings: CodeFinding[], tool: string): boolean {
  const id = toolFailedId(tool);
  return findings.some((row) => row.id === id);
}

export async function runTool<T>(tool: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.warn(`[audit] ${tool} failed`, error);
    return fallback;
  }
}
