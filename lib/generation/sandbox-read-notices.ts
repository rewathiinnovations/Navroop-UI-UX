/**
 * User-facing copy for the two ways the generate stream can fail to load
 * current files. Kept here so the route and the tests share one sentence
 * each — someone reading chat should learn one clear fact, not two
 * overlapping warnings that look like two separate failures.
 *
 * A leftover `context.sandboxId` without a live `global.activeSandbox` is
 * the same fact as "no workspace is running". `readSandboxFiles()` only
 * looks at `global.activeSandbox` and returns "No active sandbox" — retrying
 * it after the no-files notice would emit a second warning for the same gap.
 */

export const NO_PROJECT_FILES_NOTICE =
  "I could not find any files for this project, so there is nothing for me to change yet. Open the project preview so its workspace starts and its current files load, then send this request again. If the project has never generated a website, describe the site you want and I will build it from scratch.";

export const SANDBOX_READ_FAILED_NOTICE =
  'Could not read the current files from the sandbox. Proceeding with general edit mode.';

export function shouldRetrySandboxFileRead(input: {
  hasBackendFiles: boolean;
  isEdit: boolean;
  hasActiveSandbox: boolean;
}): boolean {
  return !input.hasBackendFiles && input.isEdit && input.hasActiveSandbox;
}
