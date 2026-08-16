import { NextRequest, NextResponse } from 'next/server';
import {
  generateProjectImage,
  listProjectAssets,
  searchProjectStock,
  uploadProjectAsset,
} from '@/lib/assets/actions';
import { actionError } from '@/lib/projects/http';
import type { GenerateAspect } from '@/lib/assets/generate-image';

const ASPECTS = new Set<GenerateAspect>(['16:9', '1:1', '4:5', '1200x630']);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await listProjectAssets(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ assets: result.data });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const result = await uploadProjectAsset(id, formData);
    if (!result.ok) return actionError(result);
    return NextResponse.json({ asset: result.data });
  }

  const body = (await request.json()) as {
    action?: string;
    prompt?: string;
    query?: string;
    aspectRatio?: string;
  };

  if (body.action === 'stock') {
    const result = await searchProjectStock(id, String(body.query || ''));
    if (!result.ok) return actionError(result);
    return NextResponse.json({ asset: result.data });
  }

  const aspect = ASPECTS.has(body.aspectRatio as GenerateAspect)
    ? (body.aspectRatio as GenerateAspect)
    : '16:9';
  const result = await generateProjectImage(id, String(body.prompt || ''), aspect);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ asset: result.data });
}
