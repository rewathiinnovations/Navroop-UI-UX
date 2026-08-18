import type { BuildCheckResult, BuildError } from './build-check';

/**
 * Turns a failed build into the follow-up instruction the auto-fix loop sends.
 * Mirrors lib/audit/fix-instruction.ts so a build fix reads like every other
 * fix in the product rather than like a stack trace pasted into chat.
 */

function locate(error: BuildError): string {
  if (error.file && typeof error.line === 'number') return `${error.file}:${error.line}`;
  return error.file ?? '';
}

/** Files the compiler actually named — the edit should stay inside this set. */
export function filesFromErrors(errors: BuildError[]): string[] {
  return [
    ...new Set(errors.map((error) => error.file).filter((file): file is string => Boolean(file))),
  ];
}

export function buildBuildFixInstruction(result: BuildCheckResult): string {
  const list = result.errors
    .map((error, index) => {
      const where = locate(error);
      return `${index + 1}. ${error.message}${where ? ` (${where})` : ''}`;
    })
    .join('\n');

  const files = filesFromErrors(result.errors);

  return [
    'The site you just generated does not compile. Fix the build errors below. This is a build edit — change only what is required to make the build pass.',
    `Build errors:\n${list}`,
    files.length ? `Files named by the compiler: ${files.join(', ')}` : '',
    result.missingPackages.length
      ? `These imports have no matching dependency: ${result.missingPackages.join(', ')}. Either add the dependency or replace the import with something already available.`
      : '',
    'Do not redesign, restructure, or "improve" anything else — a build fix that changes the design is a failed build fix. Do not add placeholders. Keep the existing stack, design direction, and SEO rules.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** One-line summary for chat and the job step. */
export function describeBuildFailure(result: BuildCheckResult): string {
  const count = result.errors.length;
  const first = result.errors[0]?.message ?? 'unknown error';
  const where = result.errors[0] ? locate(result.errors[0]) : '';
  const suffix = count > 1 ? ` (+${count - 1} more)` : '';
  return `Build failed: ${first}${where ? ` at ${where}` : ''}${suffix}`;
}
