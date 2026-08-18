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
    return `TXT ${input.hostname} is ${found}${privateNote}; expected ${input.expected}`;
  }
  return `${input.recordType} record for ${input.hostname} is ${found}${privateNote}; expected ${input.expected}`;
}
