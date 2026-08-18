import { describe, expect, it } from 'vitest';
import { previewResponseHeaders } from '../../lib/preview/headers';

describe('preview origin isolation', () => {
  it('does not allow the preview frame to be treated as the parent origin', () => {
    const headers = previewResponseHeaders({ appOrigin: 'https://navroop.example' });
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'self' https://navroop.example");
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Content-Security-Policy']).not.toMatch(/frame-ancestors \*/);
  });
});
