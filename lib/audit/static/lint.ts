import type { StackId } from '@/lib/stacks';
import { finding, stripSandboxPrefix } from '../findings';
import { toolFailedFinding } from './tool-fail';
import type { CodeFinding, SandboxRunner } from '../types';

type EslintMessage = {
  line?: number;
  severity?: number;
  message?: string;
  ruleId?: string | null;
};

type EslintFile = {
  filePath?: string;
  messages?: EslintMessage[];
};

export function eslintConfigForStack(stack: StackId): string | null {
  if (stack === 'STATIC_HTML') return null;
  const react = stack === 'NEXTJS' || stack === 'REACT';
  const plugins = react
    ? `import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  ...tseslint.configs.recommended,
  {
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
];
`
    : `import tseslint from 'typescript-eslint';

export default [
  ...tseslint.configs.recommended,
];
`;
  return plugins;
}

export function parseEslintJson(raw: string): CodeFinding[] {
  let parsed: unknown;
  try {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const findings: CodeFinding[] = [];
  for (const file of parsed as EslintFile[]) {
    const filePath = stripSandboxPrefix(file.filePath || '');
    for (const message of file.messages || []) {
      if (!message.message) continue;
      const line = typeof message.line === 'number' ? message.line : undefined;
      const rule = message.ruleId || 'eslint';
      findings.push(
        finding({
          id: `lint:${filePath}:${line ?? 0}:${rule}`,
          category: 'lint',
          status: message.severity === 2 ? 'high' : 'medium',
          title: rule,
          detail: message.message,
          filePath: filePath || undefined,
          line,
        }),
      );
    }
  }
  return findings;
}

export async function runLintCheck(
  stack: StackId,
  sandbox: SandboxRunner | null,
): Promise<CodeFinding[]> {
  const config = eslintConfigForStack(stack);
  if (!config) return [];
  if (!sandbox) return [toolFailedFinding('lint', new Error('no build runner on this instance'))];
  try {
    if (sandbox.writeFile) {
      await sandbox.writeFile('/tmp/navroop-eslint.config.mjs', config);
    }
    const result = await sandbox.runCommand(
      'npx --yes --package eslint --package typescript-eslint --package eslint-plugin-jsx-a11y --package eslint-plugin-react-hooks eslint -c /tmp/navroop-eslint.config.mjs -f json .',
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const parsed = parseEslintJson(output);
    if (parsed.length === 0 && /error|cannot|failed/i.test(output) && !/\[\s*\]/.test(output)) {
      return [toolFailedFinding('lint', new Error(output.slice(0, 240) || 'eslint failed'))];
    }
    return parsed;
  } catch (error) {
    return [toolFailedFinding('lint', error)];
  }
}
