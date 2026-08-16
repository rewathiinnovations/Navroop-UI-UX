import type { StackId } from '@/lib/stacks';
import type { CodeFinding, SandboxRunner } from '../types';
import { runDeadCodeCheck } from './dead-code';
import { runDependencyChecks } from './dependencies';
import { runLintCheck } from './lint';
import { runTypescriptCheck } from './typescript';

export async function runStaticAnalysis(stack: StackId, sandbox: SandboxRunner | null): Promise<CodeFinding[]> {
  const skipNode = stack === 'STATIC_HTML';
  const tasks: Promise<CodeFinding[]>[] = [];
  if (!skipNode) {
    tasks.push(runTypescriptCheck(sandbox));
    tasks.push(runLintCheck(stack, sandbox));
    tasks.push(runDependencyChecks(sandbox));
    tasks.push(runDeadCodeCheck(sandbox));
  }
  const settled = await Promise.all(tasks);
  return settled.flat();
}
