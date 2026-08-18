import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { withRequest } from '@/lib/api/with-request';
import {
  completeProductTour,
  dismissPromptTips,
  getOnboardingPreferences,
} from '@/lib/onboarding/preferences';

export async function GET(request: NextRequest) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    const prefs = await getOnboardingPreferences(user.id);
    return NextResponse.json(prefs);
  });
}

export async function POST(request: NextRequest) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as { action?: string };
    if (body.action === 'dismiss-tips') {
      return NextResponse.json(await dismissPromptTips(user.id));
    }
    if (body.action === 'complete-tour') {
      return NextResponse.json(await completeProductTour(user.id));
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  });
}
