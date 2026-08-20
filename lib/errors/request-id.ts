/**
 * The id a UI error boundary shows the user and tags its Sentry event with.
 *
 * `ErrorId` tells the user to send this id to support, so it has to be the same string the
 * report carries — the root boundary, the root-layout boundary and every per-segment
 * boundary compute it here rather than each rolling its own (F-436, F-445).
 *
 * React's `digest` is the server-side hash of the thrown error and is what correlates the
 * browser with the server log, so it is preferred whenever present. A client-side throw has
 * no digest; a random id is still worth showing, because it correlates the user's screenshot
 * with the Sentry event.
 */
export function errorRequestId(digest?: string): string {
  if (digest) return digest.slice(0, 12);
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
