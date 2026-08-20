import { promises as dns } from 'node:dns';
import tls from 'node:tls';
import { isBlockedIp } from '@/lib/security/url-guard';

/**
 * Whether a custom domain's TLS certificate actually covers its hostname.
 *
 * `applicationSslReady` used to `JSON.stringify(app).toLowerCase()` and return true if the
 * blob mentioned `ssl_certificate`/`letsencrypt`/`certificate_id` — matching field names,
 * so a row with `certificate_id: null` read as "SSL issued". The domain flipped ACTIVE and
 * the timeline said Live while Let's Encrypt may have issued nothing (F-217). The only
 * trustworthy signal is a TLS handshake against the hostname and an assertion on the
 * presented SAN, which is what `probeHostnameCertificate` does.
 */

// The subset of Node's `tls.PeerCertificate` this module reads. `subjectaltname` is the
// comma-joined `DNS:a.example.com, DNS:*.example.com, IP Address:1.2.3.4` string Node exposes.
export type PeerCertificateLike = {
  subject?: { CN?: string };
  subjectaltname?: string;
  valid_from?: string;
  valid_to?: string;
};

export type CertificateProbe =
  | { status: 'ready'; coveredBy: string }
  | { status: 'pending'; reason: string }
  | { status: 'unavailable'; reason: string };

export type TlsHandshakeResult = {
  authorized: boolean;
  certificate: PeerCertificateLike;
};

export type ProbeDeps = {
  resolve?: (hostname: string) => Promise<string[]>;
  connect?: (hostname: string, timeoutMs: number) => Promise<TlsHandshakeResult>;
  now?: () => number;
  timeoutMs?: number;
};

// A handshake against a hostname whose cert is still issuing can hang; keep it short.
const DEFAULT_TIMEOUT_MS = 8_000;
const HTTPS_PORT = 443;

/**
 * The DNS names a certificate presents: every SAN `DNS:` entry, or the subject CN when
 * there is no SAN. IP SANs are ignored — this module only reasons about hostnames.
 */
function certificateNames(cert: PeerCertificateLike): string[] {
  const san = (cert.subjectaltname ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^DNS:/i.test(entry))
    .map((entry) => entry.slice(4).trim().toLowerCase())
    .filter(Boolean);
  if (san.length) return san;
  const cn = cert.subject?.CN?.trim().toLowerCase();
  return cn ? [cn] : [];
}

/**
 * RFC 6125 hostname matching: an exact name, or a leftmost `*` wildcard that covers exactly
 * one label — never the apex (`*.client.test` does not match `client.test`) and never a
 * deeper name (`*.client.test` does not match `a.b.client.test`).
 */
function certNameMatchesHost(name: string, hostLabels: string[]): boolean {
  const nameLabels = name.split('.');
  if (nameLabels.length !== hostLabels.length) return false;
  return nameLabels.every((label, index) =>
    index === 0 && label === '*' ? true : label === hostLabels[index],
  );
}

export function certificateCoversHostname(cert: PeerCertificateLike, hostname: string): boolean {
  const hostLabels = hostname.toLowerCase().split('.');
  return certificateNames(cert).some((name) => certNameMatchesHost(name, hostLabels));
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

function defaultConnect(hostname: string, timeoutMs: number): Promise<TlsHandshakeResult> {
  return new Promise<TlsHandshakeResult>((resolve, reject) => {
    const socket = tls.connect({
      host: hostname,
      port: HTTPS_PORT,
      servername: hostname,
      rejectUnauthorized: true,
    });
    const done = (fn: () => void) => {
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };
    socket.setTimeout(timeoutMs, () =>
      done(() => reject(new Error(`TLS handshake to ${hostname} timed out`))),
    );
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      const authorized = socket.authorized;
      done(() => resolve({ authorized, certificate }));
    });
    socket.once('error', (error: Error) => done(() => reject(error)));
  });
}

/**
 * Probe a hostname's live certificate. Returns `ready` only when the presented cert covers
 * the hostname and is inside its validity window — never on a guess.
 *
 * `pending` means the handshake happened but there is no usable cert for this hostname yet
 * (issuing in progress). `unavailable` means we could not look at all — the hostname does
 * not resolve, every resolved address is private (refused, reusing `isBlockedIp`), or the
 * handshake/DNS failed or timed out. `deps` injects the resolve and the connect so a test
 * never opens a socket.
 */
export async function probeHostnameCertificate(
  hostname: string,
  deps: ProbeDeps = {},
): Promise<CertificateProbe> {
  const resolve = deps.resolve ?? defaultResolve;
  const connect = deps.connect ?? defaultConnect;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now?.() ?? Date.now();

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'DNS lookup failed';
    return { status: 'unavailable', reason: `Could not resolve ${hostname}: ${reason}` };
  }
  if (!addresses.length) {
    return { status: 'unavailable', reason: `${hostname} does not resolve to any address` };
  }
  if (addresses.every((address) => isBlockedIp(address))) {
    return {
      status: 'unavailable',
      reason: `${hostname} resolves only to private addresses; refusing to probe`,
    };
  }

  let handshake: TlsHandshakeResult;
  try {
    handshake = await connect(hostname, timeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'TLS handshake failed';
    return { status: 'unavailable', reason: `TLS handshake to ${hostname} failed: ${reason}` };
  }

  if (!handshake.authorized) {
    return {
      status: 'pending',
      reason: `${hostname} presented a certificate that did not validate`,
    };
  }

  const cert = handshake.certificate;
  const presented = certificateNames(cert);
  const coveredBy = presented.find((name) =>
    certNameMatchesHost(name, hostname.toLowerCase().split('.')),
  );
  if (!coveredBy) {
    const seen = presented.length ? presented.join(', ') : 'no DNS names';
    return {
      status: 'pending',
      reason: `${hostname} is not covered by the presented certificate (${seen})`,
    };
  }

  const validTo = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
  const validFrom = cert.valid_from ? Date.parse(cert.valid_from) : NaN;
  if (Number.isNaN(validTo) || now > validTo) {
    return {
      status: 'pending',
      reason: `the certificate for ${hostname} is expired or has no expiry (valid_to: ${cert.valid_to ?? 'absent'})`,
    };
  }
  if (!Number.isNaN(validFrom) && now < validFrom) {
    return {
      status: 'pending',
      reason: `the certificate for ${hostname} is not valid yet (valid_from: ${cert.valid_from})`,
    };
  }

  return { status: 'ready', coveredBy };
}
