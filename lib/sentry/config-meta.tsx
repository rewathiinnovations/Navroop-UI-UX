import { SENTRY_CLIENT_CONFIG_META_NAME } from './client';
import { sentryDsn, sentryEnvironment, sentryTracesSampleRate } from './options';

/**
 * Server component: publishes the browser Sentry config from the /data runtime
 * config file as a meta tag (React 19 hoists it into <head>). The DSN is not a
 * secret — every browser SDK ships it in page source by design — and this is
 * the only bridge between the server-only volume file and
 * `initSentryClient()` in `lib/sentry/client.ts`. Renders nothing when Sentry
 * is not configured, so the client init stays a silent no-op.
 *
 * Statically prerendered pages bake whatever the config was at build time
 * (in Docker builds: nothing); for those, `NEXT_PUBLIC_SENTRY_DSN` is the
 * build-time fallback the client reader falls back to.
 */
export function SentryClientConfigMeta() {
  const dsn = sentryDsn();
  if (!dsn) return null;
  const content = JSON.stringify({
    dsn,
    environment: sentryEnvironment(),
    tracesSampleRate: sentryTracesSampleRate(),
  });
  return <meta name={SENTRY_CLIENT_CONFIG_META_NAME} content={content} />;
}
