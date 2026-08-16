import { decideSource } from '@/lib/assets/decide-source';
import { generateImage } from '@/lib/assets/generate-image';
import {
  parseNeedImageDirectives,
  replaceNeedImageTokens,
  type NeedImageAspect,
} from '@/lib/assets/need-image';
import { searchStockPhoto } from '@/lib/assets/stock-photo';

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
    const asset =
      source === 'stock'
        ? await searchStockPhoto({ projectId: input.projectId, query: directive.description })
        : await generateImage({
            projectId: input.projectId,
            userId: input.userId,
            prompt: directive.description,
            aspectRatio: directive.aspect as NeedImageAspect,
          });
    replacements.push({ token: directive.token, url: asset.url });
  }

  return input.files.map((file) => ({
    path: file.path,
    content: replaceNeedImageTokens(file.content, replacements),
  }));
}
