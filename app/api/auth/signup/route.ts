import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: 'Public signup is disabled. Ask an admin to invite you.' },
    { status: 403 },
  );
}
