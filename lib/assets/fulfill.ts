import { decideSource } from '@/lib/assets/decide-source';
import { generateImage } from '@/lib/assets/generate-image';
import {
  parseNeedImageDirectives,
  replaceNeedImageTokens,
  type NeedImageAspect,
} from '@/lib/assets/need-image';
import { searchStockPhoto } from '@/lib/assets/stock-photo';
import { checkCredits, consumeCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';

export type FulfillableFile = { path: string; content: string };

export async function fulfillNeedImages(input: {
  projectId: string;
  userId?: string | null;
  files: FulfillableFile[];
  sourceOverride?: 'stock' | 'generated';
}): Promise<FulfillableFile[]> {
  const combined = input.files.map((file) => file.content).join('\n');
  const directives = parseNeedImageDirectives(combined);
  if (directives.length === 0) return input.files;

  const replacements: Array<{ token: string; url: string }> = [];
  for (const directive of directives) {
    const source = input.sourceOverride ?? decideSource(directive.description);
    if (source !== 'stock') {
      if (!input.userId) continue;
      const credits = await checkCredits(WORKSPACE_ROW_ID, input.userId, 'image');
      if (!credits.ok) {
        console.warn('[assets] skip NEED_IMAGE, credits denied', credits.reason);
        continue;
      }
      const asset = await generateImage({
        projectId: input.projectId,
        userId: input.userId,
        prompt: directive.description,
        aspectRatio: directive.aspect as NeedImageAspect,
      });
      await consumeCredits(WORKSPACE_ROW_ID, input.userId, 'image', input.projectId);
      replacements.push({ token: directive.token, url: asset.url });
      continue;
    }
    const asset = await searchStockPhoto({ projectId: input.projectId, query: directive.description });
    replacements.push({ token: directive.token, url: asset.url });
  }

  return input.files.map((file) => ({
    path: file.path,
    content: replaceNeedImageTokens(file.content, replacements),
  }));
}
