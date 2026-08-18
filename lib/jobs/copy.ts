import { NO_PROVIDER_CONFIGURED_MESSAGE } from '../ai/providers';
import { IMPORT_NO_FILES_MESSAGE } from '../import/copy';
import { BLOCKED_ACCESS_MESSAGE } from '../import/error-messages';
import { URL_GUARD_MESSAGES } from '../security/url-guard-messages';
import type { JobErrorCode } from './types';

/**
 * Headings for kinds that can reach a RecoveryPanel (chat or publish sheet).
 * Other kinds are hidden from chat and do not get a mechanical ninth heading.
 */
const RECOVERY_HEADINGS = {
  PLAN: 'The last plan did not finish',
  BUILD: 'The last build did not finish',
  FOLLOWUP: 'The last edit did not finish',
  IMPORT: 'The last import did not finish',
  PUBLISH: 'Publish did not finish',
} as const;

export function recoveryHeading(kind?: string | null): string {
  if (kind && kind in RECOVERY_HEADINGS) {
    return RECOVERY_HEADINGS[kind as keyof typeof RECOVERY_HEADINGS];
  }
  return RECOVERY_HEADINGS.BUILD;
}

export const RECOVERY_HEADING = RECOVERY_HEADINGS.BUILD;
export const PUBLISH_RECOVERY_HEADING = RECOVERY_HEADINGS.PUBLISH;
export const PUBLISH_ROLLBACK_LINE = 'Incomplete work was cleaned up';
export const PUBLISH_KEPT_LIVE_LINE = 'Your previous live site is still running';
export const KEEP_BUILT_LABEL = 'Keep what was built';
export const KEEP_IMPORTED_LABEL = 'Keep what was imported';
export const TRY_AGAIN_LABEL = 'Try again';
export const START_OVER_LABEL = 'Start over';
export const POLL_TIMEOUT_CAUSE = 'The build ran too long';

/**
 * One plain-English line per job error code, shown under the recovery heading.
 *
 * Typed as an exhaustive `Record<JobErrorCode, string>` on purpose: a new code added to
 * the union without copy here fails `tsc` instead of silently rendering a recovery panel
 * that says only "The last build did not finish".
 */
const CAUSE_LINES: Record<JobErrorCode, string> = {
  server_restarted: 'The server restarted',
  timeout: 'The build ran too long',
  provider_error: 'The AI service did not respond',
  deploying: 'The server is deploying',
  cancelled: 'The build was stopped',
  admin_abandoned: 'An administrator stopped this build',
  job_cap_exceeded: 'This build got too large — try a shorter prompt',
  loop_detected: 'Loop detected — the same file was rewritten too many times',
  queue_timeout: 'The build waited too long in the queue',
  client_disconnected: 'Your browser disconnected before the build finished',
  no_files_generated: 'The AI finished without producing any files',
  stack_mismatch:
    "The AI wrote files that don't fit this project's framework, so they were not applied",
  tool_call_validation_failed: 'The AI replied in a form we could not use — try again',
  credits_exhausted: "This month's credits are used up",
  plan_failed: 'The plan for this build could not be written',
  // The build itself may well have finished — what failed was recording how it ended, so
  // the safe advice is "reload, then check whether your changes are there".
  settle_write_failed:
    'We could not record how this build ended — reload the project, and if your changes are missing, try again',
  // Covers all three apply pre-flight messages (boot failure, no snapshot, nothing
  // running). The panel shows only this line; the specific message is on the job row for
  // /admin/jobs, so this stays true whichever of the three happened.
  sandbox_unavailable: 'The workspace for this project could not be started',
  snapshot_unreadable:
    "We could not read this project's files from storage — try publish again in a few minutes",
  sandbox_list_failed:
    'We could not list the files in the live workspace — publish was not started from an older snapshot. Try again',
  sandbox_file_unreadable:
    'We could not read a file from the live workspace — publish was not started with an incomplete site. Try again',
  sandbox_status_unknown:
    'We could not tell whether the live workspace is still running — publish was not started from an older snapshot. Try again',
  provider_not_configured: NO_PROVIDER_CONFIGURED_MESSAGE,
  provider_quota_exhausted:
    'DeepSeek is out of quota — try again later, or check the plan and billing details on the DeepSeek account.',
  request_rejected:
    'The AI could not accept this request — it may be too large or against the content policy. Try a shorter prompt.',
  // One code for every hard URL-import abort (blocked page, login wall, SSRF,
  // capture timeout, empty filesXml). Chat already has the specific sentence;
  // this line must not call that an AI-provider miss, and must not promise a
  // retry that the panel will not offer (blocked / SSRF / unresolved).
  import_failed:
    'The import could not finish — the source page was blocked, rejected, or produced no files.',
};

/**
 * Codes whose recorded `errorMessage` says the same thing as the curated line, only more
 * precisely — `providerFailureMessage` names the vendor and what it did ("Gemini rejected
 * the API key", "out of quota (generate_content_free_tier)").
 *
 * The generic line for `provider_not_configured` tells the reader to set one of four API
 * keys, which is actively wrong when a key *is* set and the vendor rejected it. Every other
 * code keeps its curated line: `sandbox_unavailable` covers three different pre-flight
 * messages on purpose, and `provider_error` records a raw provider string that is usually
 * worse copy than the sentence written for it.
 */
const RECORDED_CAUSE_CODES = new Set<string>([
  'provider_not_configured',
  'provider_quota_exhausted',
]);

/** True when the job recorded a sentence more specific than the curated cause line. */
function recordedCause(errorCode: string, errorMessage: string | null | undefined) {
  if (!RECORDED_CAUSE_CODES.has(errorCode)) return null;
  const recorded = errorMessage?.trim();
  if (!recorded) return null;
  const generic = isKnownJobErrorCode(errorCode) ? CAUSE_LINES[errorCode] : '';
  return recorded === generic ? null : recorded;
}

export function recoveryCauseLine(
  errorCode: string | null | undefined,
  errorMessage?: string | null,
) {
  if (!errorCode) return '';
  const recorded = recordedCause(errorCode, errorMessage);
  if (recorded) return recorded;
  return isKnownJobErrorCode(errorCode) ? CAUSE_LINES[errorCode] : '';
}

/** Every key of `CAUSE_LINES`, for callers that need to enumerate the codes. */
export function knownJobErrorCodes(): JobErrorCode[] {
  return Object.keys(CAUSE_LINES).filter(isKnownJobErrorCode);
}

export function filesWrittenLabel(count: number) {
  return `${count} files were already written`;
}

export function keepActionLabel(kind?: string | null) {
  return kind === 'IMPORT' ? KEEP_IMPORTED_LABEL : KEEP_BUILT_LABEL;
}

/**
 * Import and plan jobs do not increment `filesWritten` / `partialFiles` as a
 * partial site. A non-zero count on those rows is not something the
 * keep-build path can save.
 */
export function offersRecoveryKeep(input: { kind?: string | null; filesWritten: number }) {
  if (input.kind === 'IMPORT' || input.kind === 'PLAN') return false;
  return input.filesWritten > 0;
}

const IMPORT_NO_RETRY_MESSAGES = new Set<string>([
  BLOCKED_ACCESS_MESSAGE,
  URL_GUARD_MESSAGES.private,
  URL_GUARD_MESSAGES.unresolved,
  URL_GUARD_MESSAGES.protocol,
  URL_GUARD_MESSAGES.credentials,
  URL_GUARD_MESSAGES.port,
  URL_GUARD_MESSAGES.content_type,
  URL_GUARD_MESSAGES.too_large,
  URL_GUARD_MESSAGES.redirect,
]);

const NO_RETRY_CODES = new Set<string>([
  'credits_exhausted',
  'provider_not_configured',
  'request_rejected',
]);

export function offersRecoveryRetry(input: {
  kind?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  if (input.errorCode && NO_RETRY_CODES.has(input.errorCode)) return false;
  if (
    input.kind === 'IMPORT' &&
    input.errorMessage &&
    IMPORT_NO_RETRY_MESSAGES.has(input.errorMessage)
  ) {
    return false;
  }
  return true;
}

export function recoveryNextStepLine(input: {
  kind?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  if (input.errorCode === 'credits_exhausted') {
    return "This month's credits are used up. Add credits, or wait for the monthly reset.";
  }
  if (input.errorCode === 'provider_not_configured') {
    // The cause line above already shows the recorded vendor sentence when there is one, and
    // repeating the generic "set one of these four keys" underneath it contradicts it.
    return recordedCause(input.errorCode, input.errorMessage) ? '' : NO_PROVIDER_CONFIGURED_MESSAGE;
  }
  if (input.errorCode === 'request_rejected') {
    return 'The AI could not accept this request. Try a shorter prompt — sending the same one will be rejected again.';
  }
  if (input.errorCode === 'sandbox_unavailable') {
    return 'Try again starts a new billed build. The last files were not saved.';
  }
  if (input.kind !== 'IMPORT') return '';
  if (input.errorMessage === BLOCKED_ACCESS_MESSAGE) {
    return 'This site blocked automated access. Paste the page content instead — trying the same URL will be blocked again.';
  }
  if (input.errorMessage === URL_GUARD_MESSAGES.private) {
    return 'This URL is on a private network and cannot be imported. Use a public page, or paste the content.';
  }
  if (input.errorMessage === URL_GUARD_MESSAGES.unresolved) {
    return 'This website could not be resolved. Check the address, or paste the page content.';
  }
  if (input.errorMessage === URL_GUARD_MESSAGES.protocol) {
    return `${URL_GUARD_MESSAGES.protocol}. Use a public http or https page, or paste the content.`;
  }
  if (input.errorMessage === URL_GUARD_MESSAGES.credentials) {
    return `${URL_GUARD_MESSAGES.credentials}. Remove the login details, or paste the content.`;
  }
  if (input.errorMessage === URL_GUARD_MESSAGES.port) {
    return `${URL_GUARD_MESSAGES.port}. Use a public page, or paste the content.`;
  }
  if (input.errorMessage === URL_GUARD_MESSAGES.content_type) {
    return `${URL_GUARD_MESSAGES.content_type}. Use a regular web page, or paste the content.`;
  }
  if (input.errorMessage === URL_GUARD_MESSAGES.too_large) {
    return `${URL_GUARD_MESSAGES.too_large}. Try a smaller page, or paste the content.`;
  }
  if (input.errorMessage === URL_GUARD_MESSAGES.redirect) {
    return `${URL_GUARD_MESSAGES.redirect}. Use the final public URL, or paste the content.`;
  }
  if (
    input.errorMessage === IMPORT_NO_FILES_MESSAGE ||
    input.errorMessage === URL_GUARD_MESSAGES.timeout
  ) {
    return '';
  }
  return '';
}

const APPLY_FILE_FAILURE_PREFIXES = [
  'Failed to create ',
  'Morph apply failed for ',
  'Morph apply exception for ',
] as const;

export function isApplyFileFailure(error: string): boolean {
  return APPLY_FILE_FAILURE_PREFIXES.some((prefix) => error.startsWith(prefix));
}

function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

/**
 * Closing sentence for apply-ai-code-stream.
 *
 * File-write / Morph misses are a partial apply: some files landed, some did
 * not. Preview and package problems already have their own warning frames and
 * must not turn a successful write into "files failed".
 */
export function applyOutcome(input: {
  filesCreated: readonly string[];
  filesUpdated?: readonly string[];
  errors: readonly string[];
}): { message: string; warning: string | null } {
  const created = input.filesCreated.length;
  const applied = created + (input.filesUpdated?.length ?? 0);
  const failed = input.errors.filter(isApplyFileFailure).length;

  if (failed === 0) {
    return { message: `Successfully applied ${created} files`, warning: null };
  }

  const failedBit = countLabel(failed, 'file could not be written', 'files could not be written');
  const message =
    applied === 0
      ? `${failedBit} — try again`
      : `${countLabel(applied, 'file was applied', 'files were applied')}. ${failedBit} — try again`;

  return { message, warning: message };
}

export function isKnownJobErrorCode(code: string | null | undefined): code is JobErrorCode {
  return Boolean(code && code in CAUSE_LINES);
}
