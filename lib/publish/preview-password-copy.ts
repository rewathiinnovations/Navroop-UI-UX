import { PREVIEW_BASIC_USER } from './constants';

/**
 * The publish sheet's copy for a preview-password change. Pure, and imported by a client
 * component — no Prisma, no logger, no node builtins.
 */

/**
 * Both preview gates demand the same account: Traefik enforces it on static stacks and the
 * injected middleware checks it on node stacks (F-231). The sheet never said so, which made
 * a correct password look like a broken one.
 */
export const PREVIEW_SIGN_IN_HINT = `Sign in with the username "${PREVIEW_BASIC_USER}".`;

export type PreviewPasswordNotice = {
  /** `info` when the change is not in force yet, so the toast does not read as a receipt. */
  tone: 'success' | 'info';
  message: string;
};

/**
 * A node stack cannot apply a preview password without a build: the gate is injected into
 * the deploy repo and the password it compares against is an env var Coolify only applies on
 * deploy. That build used to be awaited inside the request; it now runs in the background
 * (F-232), so the sheet has to say "republishing" rather than "protection on" until the job
 * settles — the publish steps the sheet already renders are what the user follows.
 */
export function previewPasswordNotice(
  password: string | null,
  job: { kind: string; status: string } | null,
): PreviewPasswordNotice {
  const rebuilding =
    job?.kind === 'PUBLISH' && (job.status === 'QUEUED' || job.status === 'RUNNING');
  if (rebuilding) {
    return {
      tone: 'info',
      message: password
        ? `Password saved — republishing the preview so the gate goes live. ${PREVIEW_SIGN_IN_HINT}`
        : 'Password cleared — republishing the preview so the gate comes off.',
    };
  }
  return {
    tone: 'success',
    message: password
      ? `Password protection on. ${PREVIEW_SIGN_IN_HINT}`
      : 'Password protection off.',
  };
}
