import { finding, stripSandboxPrefix } from '../findings';
import { toolFailedFinding } from './tool-fail';
import type { CodeFinding, SandboxRunner } from '../types';

type KnipExport = {
  file?: string;
  name?: string;
};

type KnipJson = {
  files?: string[];
  exports?: KnipExport[];
};

export function parseKnipJson(raw: string): CodeFinding[] {
  let parsed: KnipJson;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw) as KnipJson;
  } catch {
    return [];
  }
  const findings: CodeFinding[] = [];
  for (const file of parsed.files || []) {
    const filePath = stripSandboxPrefix(file);
    findings.push(
      finding({
        id: `dead-code:file:${filePath}`,
        category: 'dead-code',
        status: 'low',
        title: `Unused file ${filePath}`,
        detail: `${filePath} is not imported by the rest of the project.`,
        filePath,
      }),
    );
  }
  for (const item of parsed.exports || []) {
    if (!item.file || !item.name) continue;
    const filePath = stripSandboxPrefix(item.file);
    findings.push(
      finding({
        id: `dead-code:export:${filePath}:${item.name}`,
        category: 'dead-code',
        status: 'low',
        title: `Unused export ${item.name}`,
        detail: `${item.name} in ${filePath} is never imported.`,
        filePath,
      }),
    );
  }
  return findings;
}

const TS_PRUNE = /^(.+?):(\d+)\s+-\s+(.+)$/;

export function parseTsPruneOutput(output: string): CodeFinding[] {
  const findings: CodeFinding[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = TS_PRUNE.exec(raw.trim());
    if (!match) continue;
    const filePath = stripSandboxPrefix(match[1]);
    const line = Number(match[2]);
    const name = match[3].trim();
    findings.push(
      finding({
        id: `dead-code:prune:${filePath}:${line}:${name}`,
        category: 'dead-code',
        status: 'low',
        title: `Unused export ${name}`,
        detail: `${name} in ${filePath} is never imported.`,
        filePath,
        line,
      }),
    );
  }
  return findings;
}

export async function runDeadCodeCheck(sandbox: SandboxRunner | null): Promise<CodeFinding[]> {
  if (!sandbox)
    return [toolFailedFinding('dead-code', new Error('no build runner on this instance'))];
  try {
    const knip = await sandbox.runCommand('npx --yes knip --reporter json');
    const fromKnip = parseKnipJson(`${knip.stdout}\n${knip.stderr}`);
    if (fromKnip.length > 0) return fromKnip;
    if (/error|ENOENT|Cannot find/i.test(`${knip.stdout}\n${knip.stderr}`)) {
      const pruned = await sandbox.runCommand('npx --yes ts-prune');
      const fromPrune = parseTsPruneOutput(`${pruned.stdout}\n${pruned.stderr}`);
      if (fromPrune.length > 0) return fromPrune;
    }
    return fromKnip;
  } catch (error) {
    try {
      const pruned = await sandbox.runCommand('npx --yes ts-prune');
      return parseTsPruneOutput(`${pruned.stdout}\n${pruned.stderr}`);
    } catch (fallbackError) {
      return [
        toolFailedFinding('dead-code', fallbackError instanceof Error ? fallbackError : error),
      ];
    }
  }
}
