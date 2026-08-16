import { finding } from '../findings';
import { toolFailedFinding } from './tool-fail';
import type { CodeFinding, SandboxRunner } from '../types';

type DepcheckJson = {
  dependencies?: string[];
  devDependencies?: string[];
};

type AuditEntry = {
  name?: string;
  severity?: string;
  via?: unknown;
};

export function parseDepcheckJson(raw: string): CodeFinding[] {
  let parsed: DepcheckJson;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw) as DepcheckJson;
  } catch {
    return [];
  }
  const unused = [...(parsed.dependencies || []), ...(parsed.devDependencies || [])];
  return unused.map((name) =>
    finding({
      id: `dependencies:unused:${name}`,
      category: 'dependencies',
      status: 'low',
      title: `Unused dependency ${name}`,
      detail: `${name} is listed in package.json but depcheck did not find a reference.`,
    }),
  );
}

function auditStatus(severity: string): CodeFinding['status'] | null {
  const value = severity.toLowerCase();
  if (value === 'critical' || value === 'high') return 'high';
  if (value === 'moderate') return 'medium';
  return null;
}

export function parseNpmAuditJson(raw: string): CodeFinding[] {
  let parsed: { vulnerabilities?: Record<string, AuditEntry> };
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
  } catch {
    return [];
  }
  const findings: CodeFinding[] = [];
  for (const [key, entry] of Object.entries(parsed.vulnerabilities || {})) {
    const name = entry.name || key;
    const status = auditStatus(entry.severity || '');
    if (!status) continue;
    findings.push(
      finding({
        id: `dependencies:audit:${name}`,
        category: 'dependencies',
        status,
        title: `${name} has a ${entry.severity} advisory`,
        detail: `npm audit reported ${entry.severity} severity for ${name}.`,
      }),
    );
  }
  return findings;
}

export async function runDependencyChecks(sandbox: SandboxRunner | null): Promise<CodeFinding[]> {
  if (!sandbox) return [toolFailedFinding('dependencies', new Error('No active sandbox'))];
  const findings: CodeFinding[] = [];
  try {
    const unused = await sandbox.runCommand('npx --yes depcheck --json');
    findings.push(...parseDepcheckJson(`${unused.stdout}\n${unused.stderr}`));
  } catch (error) {
    findings.push(toolFailedFinding('depcheck', error));
  }
  try {
    const audit = await sandbox.runCommand('npm audit --json');
    findings.push(...parseNpmAuditJson(`${audit.stdout}\n${audit.stderr}`));
  } catch (error) {
    findings.push(toolFailedFinding('npm-audit', error));
  }
  return findings;
}
