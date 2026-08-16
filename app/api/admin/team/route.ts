import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error }, { status });
  }

  const members = await prisma.user.findMany({
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
