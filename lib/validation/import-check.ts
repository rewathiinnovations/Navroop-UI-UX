import {
  describeImportProblems,
  validateGeneratedImports,
  type ImportProblem,
} from '@/lib/generation/validate-imports';
import type { StackId } from '@/lib/stacks';
import { buildErrorSignature, type BuildCheckResult, type BuildError } from './build-check';

/**
 * Adapts the static import check (`lib/generation/validate-imports.ts`) to the
 * shape the auto-fix loop already speaks, so one refusal policy governs both
 * checks instead of a second one growing here.
 *
 * This check exists because it is free: no bundler, no sandbox, no I/O. It runs
 * on every generation, including when automatic fixing is switched off, and it
 * catches the class that actually reached a user — a named import of an export
 * the model never wrote.
 */

export type ImportCheckOutcome = {
  result: BuildCheckResult;
  /** Reported to the user but never fixed: a cycle is legal, working ESM. */
  warnings: string[];
  /** One line for chat and the job step. Empty when nothing failed. */
  summary: string;
};

export function checkGeneratedImports(input: {
  stack: StackId;
  /** Everything the bundle can see: the project's files merged with the new ones. */
  files: Record<string, string>;
  /** The files this run generated. Omitted checks everything. */
  scope?: string[];
}): ImportCheckOutcome {
  const { stack, files, scope } = input;

  // STATIC_HTML has no module graph — its pages carry their assets inline.
  if (stack === 'STATIC_HTML' || Object.keys(files).length === 0) {
    return {
      result: {
        status: 'skipped',
        stack,
        errors: [],
        missingPackages: [],
        signature: null,
        skipReason: stack === 'STATIC_HTML' ? 'no-build-command' : 'no-files',
      },
      warnings: [],
      summary: '',
    };
  }

  const validation = validateGeneratedImports({ files, scope });
  const warnings = validation.warnings.map((warning) => warning.message);

  if (validation.problems.length === 0) {
    return {
      result: { status: 'passed', stack, errors: [], missingPackages: [], signature: null },
      warnings,
      summary: '',
    };
  }

  const errors: BuildError[] = validation.problems.map(toBuildError);
  return {
    result: {
      status: 'failed',
      stack,
      errors,
      // Nothing installable: every problem here is a file or a symbol the model
      // has to write, so offering an install would waste a retry.
      missingPackages: [],
      signature: buildErrorSignature(errors),
    },
    warnings,
    summary: describeImportProblems(validation),
  };
}

function toBuildError(problem: ImportProblem): BuildError {
  return {
    // `import` rather than `missing-package`: the policy installs packages for
    // that kind, and there is nothing to install for a symbol that was never
    // written.
    kind: 'import',
    message: problem.message,
    file: problem.file,
    line: problem.line,
  };
}
