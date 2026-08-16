import { finding, stripSandboxPrefix } from '../findings';
import { toolFailedFinding } from './tool-fail';
import type { CodeFinding, SandboxRunner } from '../types';

const TSC_LINE = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.+)$/;

export function parseTscOutput(output: string): CodeFinding[] {
  const findings: CodeFinding[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = TSC_LINE.exec(raw.trim());
    if (!match) continue;
    const filePath = stripSandboxPrefix(match[1]);
    const line = Number(match[2]);
    const code = match[3];
    const message = match[4];
    findings.push(
      finding({
        id: `typescript:${filePath}:${line}:${code}`,
        category: 'typescript',
        status: 'high',
        title: `${code} in ${filePath}`,
        detail: message,
        filePath,
        line,
      }),
    );
  }
  return findings;
}

export async function runTypescriptCheck(sandbox: SandboxRunner | null): Promise<CodeFinding[]> {
  if (!sandbox) return [toolFailedFinding('typescript', new Error('No active sandbox'))];
  try {
    const result = await sandbox.runCommand('npx --yes tsc --noEmit --pretty false');
    const output = `${result.stdout}\n${result.stderr}`;
    return parseTscOutput(output);
  } catch (error) {
    return [toolFailedFinding('typescript', error)];
  }
}
