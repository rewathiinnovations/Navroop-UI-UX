import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('trusted providers do not use safeFetch', () => {
  it('Coolify, Cloudflare, GitHub, and Resend stay on raw fetch', () => {
    const files = [
      'lib/coolify/client.ts',
      'lib/cloudflare/dns.ts',
      'lib/github/deploy-client.ts',
      'lib/email/client.ts',
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source, file).not.toMatch(/safeFetch\s*\(/);
    }
  });
});
