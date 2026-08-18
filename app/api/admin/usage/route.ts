import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

/**
 * The usage dashboard renders every member in one page, so the query is bounded
 * at 500 rather than paginated. A workspace that grows past 500 members
 * silently loses the tail here and needs real pagination — the cap is a
 * safety bound against an unbounded query, not a product decision.
 */
const MEMBER_LIST_CAP = 500;

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error }, { status });
  }

  const [memberCount, projectCount, generatingCount, members] = await Promise.all([
    prisma.user.count(),
    prisma.project.count(),
    prisma.project.count({
      where: { status: { in: ['generating', 'applying'] } },
    }),
    // Safety bound, not pagination: the usage dashboard renders every member.
    prisma.user.findMany({
      take: MEMBER_LIST_CAP,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        updatedAt: true,
        _count: { select: { projects: true } },
        projects: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { updatedAt: true },
        },
      },
    }),
  ]);

  return NextResponse.json({
    summary: {
      members: memberCount,
      projects: projectCount,
      generating: generatingCount,
    },
    members: members.map((member) => ({
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      projectCount: member._count.projects,
      lastActiveAt: member.projects[0]?.updatedAt ?? member.updatedAt,
    })),
  });
}
