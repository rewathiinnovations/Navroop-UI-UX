/**
 * The one resolver for this installation's workspace name, server-side.
 *
 * The GitHub App manifest (`Navroop Deploy — <name>`) and the Sentry project this product
 * creates both used to read `process.env.NEXT_PUBLIC_WORKSPACE_NAME` directly. A
 * `NEXT_PUBLIC_*` variable is inlined at build time, so an operator who renamed the
 * workspace and re-ran either connect flow got the old name baked into a GitHub App and a
 * Sentry project, correctable only by a rebuild and redeploy (F-240). `github-manifest.ts`
 * documents the same move for the app *URL*; the name was left behind.
 *
 * Precedence is the registry's: the value saved in the admin UI, then `WORKSPACE_NAME` and
 * the legacy `NEXT_PUBLIC_WORKSPACE_NAME` alias, then the fallback.
 *
 * `NEXT_PUBLIC_WORKSPACE_NAME` stays the browser's copy of the name (the dashboard heading,
 * the email templates) — those reads are inlined by design and cannot consult a database.
 *
 * Server-only: reads Prisma through the settings registry.
 */
import { getSetting } from './resolve';

export const WORKSPACE_NAME_FALLBACK = 'Navroop';

export async function workspaceDisplayName(): Promise<string> {
  return (await getSetting('app.workspaceName'))?.trim() || WORKSPACE_NAME_FALLBACK;
}
