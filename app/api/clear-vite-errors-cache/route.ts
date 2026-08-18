import { NextResponse } from 'next/server';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';

declare global {
  var viteErrorsCache: { errors: any[], timestamp: number } | null;
}

export async function POST() {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  try {
    // Clear the cache
    global.viteErrorsCache = null;
    
    console.log('[clear-vite-errors-cache] Cache cleared');
    
    return NextResponse.json({
      success: true,
      message: 'Vite errors cache cleared'
    });
    
  } catch (error) {
    console.error('[clear-vite-errors-cache] Error:', error);
    return NextResponse.json({ 
      success: false, 
      error: (error as Error).message 
    }, { status: 500 });
  }
}