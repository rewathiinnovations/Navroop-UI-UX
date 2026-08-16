import { finding } from '../findings';
import type { CodeFinding } from '../types';

export function toolFailedFinding(tool: string, error: unknown): CodeFinding {
  const message = error instanceof Error ? error.message : String(error || 'unknown error');
  return finding({
    id: `tool:${tool}`,
    category: 'tool',
    status: 'low',
    title: `${tool} check could not run`,
    detail: `Informational only — ${tool} failed (${message}). The rest of the audit continued.`,
    fixable: false,
  });
}

export async function runTool<T>(tool: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.warn(`[audit] ${tool} failed`, error);
    return fallback;
  }
}
