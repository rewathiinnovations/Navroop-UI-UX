import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

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
    prisma.user.findMany({
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
