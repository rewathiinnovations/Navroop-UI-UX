import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { auditRowsToCsv, listAuditLogs } from '@/lib/audit/admin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const url = request.nextUrl;
  const rows = await listAuditLogs({
    actor: url.searchParams.get('actor') || undefined,
    action: url.searchParams.get('action') || undefined,
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
  });

  if (url.searchParams.get('format') === 'csv') {
    return new NextResponse(auditRowsToCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="audit-log.csv"',
      },
    });
  }

  return NextResponse.json({
    rows: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    })),
  });
}
