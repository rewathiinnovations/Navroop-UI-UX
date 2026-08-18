import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

/**
 * The admin team table renders every member in one page, so the query is
 * bounded at 500 rather than paginated. A workspace that grows past 500 members
 * silently loses the tail here and needs real pagination — the cap is a
 * safety bound against an unbounded query, not a product decision.
 */
const MEMBER_LIST_CAP = 500;

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error }, { status });
  }

  // Safety bound, not pagination: the admin table renders every member.
  const members = await prisma.user.findMany({
    take: MEMBER_LIST_CAP,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
      _count: { select: { projects: true } },
    },
  });

  return NextResponse.json({
    members: members.map((member) => ({
      id: member.id,
      email: member.email,
      name: member.name,
      role: member.role,
      createdAt: member.createdAt,
      projectCount: member._count.projects,
    })),
  });
}
