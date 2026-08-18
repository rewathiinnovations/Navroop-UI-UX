/**
 * Failed-job line on /admin/jobs. `lastStep` is a key like `import`; the
 * sentence the user already saw lives on `errorMessage`.
 */
export function jobAdminFailureLine(job: {
  lastStep: string | null;
  errorMessage: string | null;
}): string {
  const message = job.errorMessage?.trim();
  if (message) return message;
  return job.lastStep || 'no step';
}
