/**
 * Shared with `playwright.config.ts`, so this file must stay dependency-free —
 * the config is loaded in every worker process.
 *
 * The files it names hold live signed-in session cookies. `.gitignore` already
 * ignores `/e2e/.auth`; keep it that way.
 */
export const AUTH_STORAGE_STATE = 'e2e/.auth/user.json';

/**
 * The ADMIN session. Only the journeys that have to prove a screen is ADMIN-only
 * opt into it, with `test.use({ storageState: ADMIN_STORAGE_STATE })`; every
 * other authenticated journey stays on the MEMBER above, which is the role a
 * real teammate holds.
 */
export const ADMIN_STORAGE_STATE = 'e2e/.auth/admin.json';
