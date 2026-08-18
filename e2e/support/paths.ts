/**
 * Shared with `playwright.config.ts`, so this file must stay dependency-free —
 * the config is loaded in every worker process.
 *
 * The file it names holds a live signed-in session cookie. `.gitignore` already
 * ignores `/e2e/.auth`; keep it that way.
 */
export const AUTH_STORAGE_STATE = 'e2e/.auth/user.json';
