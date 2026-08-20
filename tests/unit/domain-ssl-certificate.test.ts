import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  certificateCoversHostname,
  probeHostnameCertificate,
  type PeerCertificateLike,
  type ProbeDeps,
} from '@/lib/domains/ssl';

/**
 * A domain flips to ACTIVE only against a certificate that actually covers its hostname.
 *
 * `applicationSslReady` used to `JSON.stringify(app).toLowerCase()` and return true if the
 * blob contained `ssl_certificate`, `letsencrypt` or `certificate_id` — matching field
 * names, so an application row with `certificate_id: null` read as "SSL issued". The
 * domain flipped ACTIVE and the timeline said Live while Let's Encrypt may have issued
 * nothing (F-217). The trustworthy signal is a TLS handshake against the hostname and an
 * assertion on the presented SAN.
 */

function cert(overrides: Partial<PeerCertificateLike> = {}): PeerCertificateLike {
  const now = Date.now();
  return {
    subject: { CN: 'shop.client.test' },
    subjectaltname: 'DNS:shop.client.test',
    valid_from: new Date(now - 86_400_000).toUTCString(),
    valid_to: new Date(now + 86_400_000).toUTCString(),
    ...overrides,
  };
}

describe('certificateCoversHostname', () => {
  it('matches an exact SAN entry case-insensitively', () => {
    const c = cert({ subjectaltname: 'DNS:www.example.com, DNS:shop.client.test' });
    expect(certificateCoversHostname(c, 'shop.client.test')).toBe(true);
    expect(certificateCoversHostname(c, 'SHOP.CLIENT.TEST')).toBe(true);
    expect(certificateCoversHostname(c, 'other.client.test')).toBe(false);
  });

  it('honours a wildcard for exactly one label, never the apex or a deeper name', () => {
    const c = cert({ subjectaltname: 'DNS:*.client.test' });
    expect(certificateCoversHostname(c, 'shop.client.test')).toBe(true);
    expect(certificateCoversHostname(c, 'client.test')).toBe(false);
    expect(certificateCoversHostname(c, 'a.b.client.test')).toBe(false);
  });

  it('falls back to the subject CN when there is no SAN', () => {
    const c = cert({ subjectaltname: undefined, subject: { CN: 'shop.client.test' } });
    expect(certificateCoversHostname(c, 'shop.client.test')).toBe(true);
    expect(certificateCoversHostname(c, 'other.client.test')).toBe(false);
  });

  it('ignores IP SAN entries', () => {
    const c = cert({ subjectaltname: 'IP Address:203.0.113.10, DNS:shop.client.test' });
    expect(certificateCoversHostname(c, '203.0.113.10')).toBe(false);
    expect(certificateCoversHostname(c, 'shop.client.test')).toBe(true);
  });

  it('is false for an empty or absent certificate', () => {
    expect(certificateCoversHostname({}, 'shop.client.test')).toBe(false);
    expect(certificateCoversHostname({ subjectaltname: '' }, 'shop.client.test')).toBe(false);
  });
});

const PUBLIC_IP = '203.0.113.10';

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    resolve: async () => [PUBLIC_IP],
    connect: async () => ({ authorized: true, certificate: cert() }),
    ...overrides,
  };
}

describe('probeHostnameCertificate', () => {
  it('is ready when the handshake presents a cert that covers the hostname', async () => {
    await expect(probeHostnameCertificate('shop.client.test', deps())).resolves.toEqual({
      status: 'ready',
      coveredBy: expect.stringContaining('shop.client.test'),
    });
  });

  it('is pending when the handshake succeeds but the cert does not cover the hostname', async () => {
    const probe = await probeHostnameCertificate('shop.client.test', {
      resolve: async () => [PUBLIC_IP],
      connect: async () => ({
        authorized: true,
        certificate: cert({
          subjectaltname: 'DNS:someone-else.test',
          subject: { CN: 'someone-else.test' },
        }),
      }),
    });

    expect(probe.status).toBe('pending');
    if (probe.status === 'pending') {
      expect(probe.reason).toContain('shop.client.test');
    }
  });

  it('is pending when the presented cert is outside its validity window', async () => {
    const expired = cert({
      valid_from: new Date(Date.now() - 172_800_000).toUTCString(),
      valid_to: new Date(Date.now() - 86_400_000).toUTCString(),
    });
    const probe = await probeHostnameCertificate('shop.client.test', {
      resolve: async () => [PUBLIC_IP],
      connect: async () => ({ authorized: true, certificate: expired }),
    });

    expect(probe.status).toBe('pending');
  });

  it('is unavailable when the handshake itself fails', async () => {
    const probe = await probeHostnameCertificate('shop.client.test', {
      resolve: async () => [PUBLIC_IP],
      connect: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    expect(probe.status).toBe('unavailable');
    if (probe.status === 'unavailable') {
      expect(probe.reason).toContain('ECONNREFUSED');
    }
  });

  it('refuses to probe when every resolved address is private', async () => {
    const probe = await probeHostnameCertificate('shop.client.test', {
      resolve: async () => ['127.0.0.1', '10.0.0.5'],
      connect: async () => {
        throw new Error('should not connect');
      },
    });

    expect(probe.status).toBe('unavailable');
  });

  it('is unavailable when the hostname does not resolve at all', async () => {
    const probe = await probeHostnameCertificate('shop.client.test', {
      resolve: async () => [],
      connect: async () => {
        throw new Error('should not connect');
      },
    });

    expect(probe.status).toBe('unavailable');
  });
});

describe('the substring SSL guess is gone', () => {
  it('applicationSslReady is no longer exported from the Coolify client', async () => {
    // Dynamic import on purpose: a static import of a removed export would fail to
    // compile, so the runtime export shape is what this case has to inspect.
    const client = (await import('@/lib/coolify/client')) as Record<string, unknown>;
    expect('applicationSslReady' in client).toBe(false);
    // The honest hostname-listing check stays.
    expect(typeof client.applicationListsHostname).toBe('function');
  });

  it('the client source no longer stringifies the app to guess SSL', () => {
    const source = readFileSync(join(process.cwd(), 'lib/coolify/client.ts'), 'utf8');
    expect(source).not.toContain('applicationSslReady');
  });
});
