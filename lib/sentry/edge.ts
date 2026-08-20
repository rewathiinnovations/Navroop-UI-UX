/**
 * Error reporting for the edge runtime, and the disclosure that goes with it.
 *
 * `proxy.ts` — the auth gate in front of every `/api` and `/preview-static` request — runs
 * in the edge isolate. A throw there was reported nowhere, and nothing said so (F-786).
 *
 * The awkward part is real: every other runtime resolves its DSN from the admin panel, via
 * the runtime config file on the /data volume. An edge isolate has no `node:fs`, so it
 * cannot read that file, and it cannot query the database either. The only DSN an edge
 * bundle can carry is a literal inlined at build time, and there is already exactly one:
 * `NEXT_PUBLIC_SENTRY_DSN`, the build-time fallback the client bundle uses, passed as a
 * build arg by the Dockerfile and docker-compose, and recognised by
 * `lib/observability/migrate-env.ts`. No new operator surface, and setting it now buys edge
 * and middleware coverage as well as static-page client coverage.
 *
 * Because that variable is optional, edge coverage is optional — so it must not be silent
 * either way. `/admin/health` reads `edgeReportingCovered()` and states plainly whether
 * edge and middleware errors are captured. Both this module and that panel go through the
 * same expression, so the page cannot claim coverage the isolate does not have.
 */

/**
 * Build-time only. A value supplied at runtime but not at build time is inlined as empty in
 * the edge bundle, which is why the disclosure names the build argument rather than telling
 * an operator to set an environment variable and restart.
 */
export function edgeSentryDsn(): string {
  return process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || '';
}

export function edgeReportingCovered(): boolean {
  return Boolean(edgeSentryDsn());
}
