import { isBlockedIp } from '@/lib/security/url-guard';

export function formatRecordMismatch(input: {
  recordType: 'A' | 'CNAME' | 'TXT';
  hostname: string;
  found: string[];
  expected: string;
}) {
  const found = input.found.length ? input.found.join(', ') : 'missing';
  const privateNote = input.found.some((ip) => isBlockedIp(ip))
    ? ' (private address — DNS is misconfigured)'
    : '';
  if (input.recordType === 'TXT') {
    // F-208: this string is persisted into `CustomDomain.lastError`, which is
    // serialised to every workspace member — including read-only viewers whose
    // payload has the verify token stripped. The token is a capability, so it
    // must never appear here; the owner-facing DNS instructions carry it behind
    // access control (`withoutVerifyToken`). `expected` is deliberately unused.
    const state = input.found.length ? 'does not match the expected value' : 'is missing';
    return `TXT ${input.hostname} ${state}; use the value from the domain's DNS instructions`;
  }
  return `${input.recordType} record for ${input.hostname} is ${found}${privateNote}; expected ${input.expected}`;
}
