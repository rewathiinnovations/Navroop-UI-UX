import { prisma } from '@/lib/db';
import { formatAuditDiff } from './log';

export type AuditListRow = {
  id: string;
  workspaceId: string | null;
  actorId: string | null;
  actorEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  createdAt: Date;
  diff: string[];
};

export async function listAuditLogs(input: {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  take?: number;
}) {
  const actor = input.actor?.trim();
  const action = input.action?.trim();
  const from = input.from ? new Date(input.from) : null;
  const to = input.to ? new Date(input.to) : null;
  const take = Math.min(Math.max(input.take ?? 200, 1), 1000);

  // Hand-numbered placeholders rather than interpolated Prisma.sql fragments — see the
  // note on JOB_COLUMNS in lib/jobs/store.ts. Every user value is still bound.
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  const filters: string[] = ['TRUE'];
  if (actor) filters.push(`"actorEmail" ILIKE ${bind(`%${actor}%`)}`);
  if (action) filters.push(`action = ${bind(action)}`);
  if (from && !Number.isNaN(from.getTime())) filters.push(`"createdAt" >= ${bind(from)}`);
  if (to && !Number.isNaN(to.getTime())) filters.push(`"createdAt" <= ${bind(to)}`);

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      workspaceId: string | null;
      actorId: string | null;
      actorEmail: string;
      action: string;
      targetType: string | null;
      targetId: string | null;
      before: unknown;
      after: unknown;
      requestId: string | null;
      createdAt: Date;
    }>
  >(
    `SELECT id, "workspaceId", "actorId", "actorEmail", action, "targetType", "targetId",
           before, after, "requestId", "createdAt"
    FROM "AuditLog"
    WHERE ${filters.join(' AND ')}
    ORDER BY "createdAt" DESC
    LIMIT ${bind(take)}`,
    ...values,
  );

  return rows.map((row) => ({
    ...row,
    diff: formatAuditDiff(row.before, row.after),
  }));
}

export function auditRowsToCsv(rows: AuditListRow[]) {
  const header = [
    'createdAt',
    'actorEmail',
    'action',
    'targetType',
    'targetId',
    'diff',
    'requestId',
  ];
  // Excel, LibreOffice and Sheets treat a cell whose first character is `=`, `+`,
  // `-`, `@`, TAB or CR as a formula, so quoting alone is not enough: `actorEmail`
  // comes from the invite flow and `diff` carries arbitrary changed values, and
  // this is the file the workspace's most privileged person opens (F-741). A
  // leading apostrophe is the portable "this is text" marker; it is stripped by
  // the spreadsheet on import, so the displayed value is unchanged.
  const escape = (value: unknown) => {
    let text = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        row.actorEmail,
        row.action,
        row.targetType ?? '',
        row.targetId ?? '',
        row.diff.join('; '),
        row.requestId ?? '',
      ]
        .map(escape)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
