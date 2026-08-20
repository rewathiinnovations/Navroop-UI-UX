import * as Sentry from '@sentry/nextjs';
import { observabilityBeforeSend } from '../observability/noise';

/**
 * How the DSN reaches the browser: the server runtime config lives in the
 * /data volume file, which the client cannot read. The root layout renders a
 * `<meta name="navroop-sentry">` tag from that config on every server render
 * (see `lib/sentry/config-meta.tsx`), so an admin DSN change takes effect on
 * the next page load without a rebuild. `NEXT_PUBLIC_SENTRY_DSN` — the name
 * `lib/observability/migrate-env.ts` already recognises — is the build-time
 * fallback for statically prerendered pages, where the meta tag was rendered
 * before the volume existed.
 */
export const SENTRY_CLIENT_CONFIG_META_NAME = 'navroop-sentry';

export type SentryClientConfig = {
  dsn: string;
  environment?: string;
  tracesSampleRate?: number;
};

export function readSentryClientConfig(
  doc: Pick<Document, 'querySelector'> | undefined = typeof document === 'undefined'
    ? undefined
    : document,
): SentryClientConfig | null {
  const content =
    doc?.querySelector(`meta[name="${SENTRY_CLIENT_CONFIG_META_NAME}"]`)?.getAttribute('content') ??
    '';
  if (content) {
    try {
      const parsed: unknown = JSON.parse(content);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'dsn' in parsed &&
        typeof parsed.dsn === 'string' &&
        parsed.dsn.trim()
      ) {
        return {
          dsn: parsed.dsn.trim(),
          environment:
            'environment' in parsed && typeof parsed.environment === 'string'
              ? parsed.environment
              : undefined,
          tracesSampleRate:
            'tracesSampleRate' in parsed && typeof parsed.tracesSampleRate === 'number'
              ? parsed.tracesSampleRate
              : undefined,
        };
      }
    } catch {
      // Malformed meta content is treated as "not configured": fall through to
      // the build-time fallback rather than crashing every page load.
    }
  }
  const envDsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  return envDsn ? { dsn: envDsn } : null;
}

let started = false;

export function initSentryClient(config: SentryClientConfig | null = readSentryClientConfig()) {
  if (started) return;
  // Sentry not configured: a silent no-op, exactly as before.
  if (!config?.dsn) return;
  started = true;
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    tracesSampleRate:
      config.tracesSampleRate ?? (process.env.NODE_ENV === 'production' ? 0.1 : 1.0),
    // The same noise suppression + secret scrubbing the server init uses
    // (lib/sentry/options.ts); both paths end in sentryBeforeSend.
    beforeSend: observabilityBeforeSend,
    sendDefaultPii: false,
  });
}
