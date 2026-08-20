import tls from 'node:tls';
import { appPublicUrl } from '../settings/app-url';
import { positiveNumberSetting } from '../settings/numbers';

/**
 * Default warning window. `app.certWarningDays` on /admin/config overrides it (F-793): how
 * much notice an operator wants before a renewal is overdue is their call, and this check is
 * already on an async cron path.
 */
const DEFAULT_CERT_RENEWAL_WINDOW_DAYS = 14;

export async function checkSiteCertificate(
  deps: { url?: string; connect?: typeof tls.connect } = {},
) {
  // The address an operator edits in /admin/config, not the build-time environment variable.
  // This read `process.env.APP_URL` directly, so changing Application URL flipped the badge on
  // the settings page and left the certificate check watching the old host until a redeploy.
  const raw = deps.url ?? (await appPublicUrl());
  let host: string;
  let port = 443;
  let protocol = 'https:';
  try {
    const parsed = new URL(raw);
    host = parsed.hostname;
    protocol = parsed.protocol;
    port = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
  } catch {
    // `appPublicUrl` always returns a value and falls back to localhost, so an unset
    // Application URL now lands on the non-TLS skip below rather than here. This branch is for
    // a saved setting that is not a URL at all, which is operator input and must say so.
    return { ok: false, detail: `the configured application URL is not a valid URL: ${raw}` };
  }
  // Only a plaintext scheme skips the check. `https://host:8443` is a TLS address with a
  // certificate that expires like any other, and skipping it as a pass meant the site went
  // down on expiry behind a green check-certs row (F-740).
  if (protocol === 'http:') {
    return { ok: true, detail: `non-TLS address ${raw} — certificate check skipped` };
  }

  const connect = deps.connect ?? tls.connect;
  const validTo = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !('valid_to' in cert) || !cert.valid_to) {
        reject(new Error('no peer certificate'));
        return;
      }
      resolve(cert.valid_to);
    });
    socket.on('error', (error) => {
      socket.destroy();
      reject(error);
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('certificate check timed out'));
    });
  });

  const expiresAt = new Date(validTo);
  if (Number.isNaN(expiresAt.getTime())) {
    // `NaN < threshold` is false, so an unparseable OpenSSL date used to sail past the
    // expiry comparison. The raw string goes in the detail: the operator needs to see what
    // the peer actually sent (F-740).
    return {
      ok: false,
      detail: `certificate expiry date could not be parsed: ${validTo} (host ${host}:${port})`,
    };
  }

  const windowDays = await positiveNumberSetting(
    'app.certWarningDays',
    DEFAULT_CERT_RENEWAL_WINDOW_DAYS,
  );
  const remainingMs = expiresAt.getTime() - Date.now();
  if (remainingMs < windowDays * 24 * 60 * 60 * 1000) {
    return {
      ok: false,
      detail: `certificate expires ${expiresAt.toISOString()} (inside the ${windowDays}-day renewal window)`,
    };
  }
  return { ok: true, detail: `certificate valid until ${expiresAt.toISOString()}` };
}
